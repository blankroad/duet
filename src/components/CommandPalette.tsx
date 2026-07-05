import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { Search } from "lucide-react";
import { usePalette } from "@/stores/palette";
import { useAllCommands } from "@/stores/commands";
import { useKeymap, effectiveKey } from "@/stores/keymap";
import { fuzzyScore } from "@/lib/fuzzy";
import { displayKey } from "@/lib/keyDisplay";
import { commandLabel, commandCategory } from "@/lib/commands";
import type { Command } from "@/lib/commands";

/**
 * Ctrl+P 커맨드 팔레트. fuzzy 매칭 + Enter 실행.
 */
export function CommandPalette() {
  const { t } = useTranslation();
  const isOpen = usePalette((s) => s.isOpen);
  const close = usePalette((s) => s.close);
  const all = useAllCommands();
  const bindings = useKeymap((s) => s.bindings);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setCursor(0);
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // 번역된 라벨로 검색/표시 — 언어 전환 시 t 가 바뀌며 자동 재계산.
  const ranked = useMemo(() => {
    const scored = all
      .map((c) => ({
        cmd: c,
        label: commandLabel(c, t),
        score: fuzzyScore(query, commandLabel(c, t)),
      }))
      .filter(
        (x): x is { cmd: Command; label: string; score: number } =>
          x.score !== null,
      );
    scored.sort((a, b) => b.score - a.score);
    return scored.map((x) => ({ cmd: x.cmd, label: x.label }));
  }, [all, query, t]);

  useEffect(() => {
    if (cursor >= ranked.length) setCursor(0);
  }, [ranked.length, cursor]);

  if (!isOpen) return null;

  const execute = (cmd: Command) => {
    close();
    cmd.action();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/4 z-50 w-full max-w-xl -translate-x-1/2 rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search size={14} className="text-fg-muted shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(ranked.length - 1, c + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const item = ranked[cursor];
                  if (item) execute(item.cmd);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder={t("palette.placeholder")}
              className="flex-1 bg-transparent font-mono text-base focus:outline-none"
            />
          </div>
          <div className="max-h-80 overflow-auto py-1">
            {ranked.length === 0 ? (
              <div className="px-3 py-2 text-meta text-fg-muted">
                {t("palette.noResults")}
              </div>
            ) : (
              ranked.map(({ cmd, label }, i) => {
                // 리바인드된 키(effective) 표시 — 팔레트가 factory 키를 보여주면
                // 사용자가 바꾼 단축키와 어긋난다.
                const key = effectiveKey(cmd.id, bindings, cmd.defaultKey);
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    onClick={() => execute(cmd)}
                    onMouseEnter={() => setCursor(i)}
                    className={`flex w-full items-center gap-3 px-3 py-1.5 text-left text-base ${
                      i === cursor ? "bg-active text-fg" : "hover:bg-border"
                    }`}
                  >
                    <span className="flex-1 truncate">{label}</span>
                    <span className="shrink-0 text-meta text-fg-muted">
                      {commandCategory(cmd.category, t)}
                    </span>
                    {key && (
                      <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-meta text-fg-muted">
                        {displayKey(key)}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          <Dialog.Description className="sr-only">
            {t("palette.title")}
          </Dialog.Description>
          <Dialog.Title className="sr-only">{t("palette.title")}</Dialog.Title>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
