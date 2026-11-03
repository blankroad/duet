import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllCommands } from "@/stores/commands";
import {
  useKeymap,
  setKeymap,
  unsetKeymap,
  resetKeymap,
  effectiveKey,
  resolveKeyCommand,
  shadowedBy,
} from "@/stores/keymap";
import { displayKey } from "@/lib/keyDisplay";
import { commandLabel, commandCategory } from "@/lib/commands";
import { KeyCaptureInput, KeyConflictPrompt } from "./KeyCapture";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Search, RotateCcw } from "lucide-react";

/** 키를 다른 명령이 쓰고 있어 바꾸기 확인을 기다리는 중. */
interface PendingConflict {
  commandId: string;
  key: string;
  ownerId: string;
}

export function KeymapSection() {
  const { t } = useTranslation();
  const all = useAllCommands();
  const bindings = useKeymap((s) => s.bindings);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<PendingConflict | null>(null);
  const labelOf = (id: string) => {
    const c = all.find((x) => x.id === id);
    return c ? commandLabel(c, t) : id;
  };

  // 이 명령에 키 지정 — 같은 명령의 예전 사용자 지정은 지운다(편집 = 교체).
  // 예전엔 Ctrl+J → Ctrl+K 로 바꿔도 Ctrl+J 가 표에 안 보이는 채 계속 동작했다.
  const apply = async (commandId: string, key: string) => {
    const stale = bindings.filter(
      (b) => b.command_id === commandId && b.key !== key,
    );
    if (!(await setKeymap(key, commandId))) return;
    for (const b of stale) await unsetKeymap(b.key);
  };

  // 사용자 지정 전부 해제 — 기본 키로. 응답 스냅숏이 뒤섞이지 않게 순서대로.
  const resetCommand = async (commandId: string) => {
    for (const b of bindings)
      if (b.command_id === commandId) await unsetKeymap(b.key);
  };

  const onCapture = (commandId: string, key: string) => {
    setEditing(null);
    const defaultKey = all.find((c) => c.id === commandId)?.defaultKey;
    if (effectiveKey(commandId, bindings, defaultKey) === key) return;
    const ownerId = resolveKeyCommand(key, bindings, all);
    if (ownerId && ownerId !== commandId) {
      setPending({ commandId, key, ownerId });
      return;
    }
    void apply(commandId, key);
  };

  const q = query.trim().toLowerCase();
  const shown = q
    ? all.filter((c) => {
        const key = effectiveKey(c.id, bindings, c.defaultKey) ?? "";
        // 번역 라벨 + 원문 라벨 둘 다 매칭 — 한국어 UI 에서 영어 검색도 동작.
        return (
          commandLabel(c, t).toLowerCase().includes(q) ||
          c.label.toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          key.toLowerCase().includes(q)
        );
      })
    : all;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 px-2 pb-2">
        <div className="relative flex-1">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.keymap.search")}
            className="w-full rounded border border-border bg-subtle py-1 pl-7 pr-2 text-base focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            void tauriConfirm(t("settings.keymap.restoreConfirm"), {
              title: t("settings.keymap.restoreDefaults"),
            }).then((ok) => {
              if (ok) void resetKeymap();
            });
          }}
          className="flex items-center gap-1 rounded border border-border px-2 py-1 text-meta text-fg-muted hover:bg-border hover:text-fg"
          title={t("settings.keymap.restoreTitle")}
        >
          <RotateCcw size={12} /> {t("settings.keymap.restoreDefaults")}
        </button>
      </div>
      <div className="grid grid-cols-[1fr_5rem_8rem_5rem] gap-2 border-b border-border px-2 py-1 text-meta text-fg-muted">
        <div>{t("settings.keymap.colCommand")}</div>
        <div>{t("settings.keymap.colCategory")}</div>
        <div>{t("settings.keymap.colKey")}</div>
        <div>{t("settings.keymap.colActions")}</div>
      </div>
      {shown.map((cmd) => {
        const bound = bindings.find((b) => b.command_id === cmd.id);
        const key = effectiveKey(cmd.id, bindings, cmd.defaultKey);
        // 기본 키를 다른 명령의 사용자 지정이 가져감 — 왜 "(없음)" 인지 보여 준다.
        const takenBy = shadowedBy(cmd.id, bindings, cmd.defaultKey);
        const conflict = pending?.commandId === cmd.id ? pending : null;
        return (
          <div key={cmd.id}>
            <div className="grid grid-cols-[1fr_5rem_8rem_5rem] items-center gap-2 px-2 py-0.5 text-base hover:bg-subtle">
              <div className="truncate" title={cmd.id}>
                {commandLabel(cmd, t)}
              </div>
              <div className="text-meta text-fg-muted">
                {commandCategory(cmd.category, t)}
              </div>
              <div>
                {editing === cmd.id ? (
                  <KeyCaptureInput
                    onCancel={() => setEditing(null)}
                    onCapture={(newKey) => onCapture(cmd.id, newKey)}
                  />
                ) : (
                  <span className="flex items-center gap-1 font-mono text-meta">
                    {key ? (
                      displayKey(key)
                    ) : (
                      <span className="text-fg-muted">
                        {t("settings.keymap.none")}
                      </span>
                    )}
                    {bound && (
                      <span
                        className="text-accent"
                        title={t("settings.keymap.customized")}
                      >
                        ●
                      </span>
                    )}
                    {takenBy && cmd.defaultKey && (
                      <span
                        className="flex items-center"
                        title={t("settings.keymap.shadowed", {
                          key: displayKey(cmd.defaultKey),
                          command: labelOf(takenBy),
                        })}
                      >
                        <AlertTriangle size={11} className="text-warning" />
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="flex gap-1 text-meta">
                <button
                  type="button"
                  onClick={() => setEditing(cmd.id)}
                  className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-border hover:text-fg"
                >
                  {t("settings.keymap.edit")}
                </button>
                {bound && (
                  <button
                    type="button"
                    onClick={() => void resetCommand(cmd.id)}
                    className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-border hover:text-fg"
                  >
                    {t("settings.keymap.reset")}
                  </button>
                )}
              </div>
            </div>
            {conflict && (
              <KeyConflictPrompt
                keyStr={conflict.key}
                ownerLabel={labelOf(conflict.ownerId)}
                onCancel={() => setPending(null)}
                onReplace={() => {
                  setPending(null);
                  void apply(conflict.commandId, conflict.key);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
