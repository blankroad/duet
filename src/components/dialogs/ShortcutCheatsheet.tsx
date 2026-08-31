import { useTranslation } from "react-i18next";
import { Keyboard } from "lucide-react";
import { useAllCommands } from "@/stores/commands";
import { useKeymap, effectiveKey } from "@/stores/keymap";
import { displayKey } from "@/lib/keyDisplay";
import { commandLabel, commandCategory } from "@/lib/commands";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";

/**
 * 단축키 치트시트 (F1) — 카테고리별 command 단축키(리바인드 반영) +
 * command 가 아닌 내장 제스처(화살표/드래그 수식키 등) 안내.
 *
 * 발견 가능성 보완용 읽기 전용 뷰 — 편집은 Settings › Keymap 에서.
 */

/** command 로 등록되지 않은 내장 키/제스처 — useKeyboardNav·DnD 하드와이어드.
 *  what 은 i18n 키 (cheatsheet.g.*). */
const BUILTIN_GESTURES: Array<{ keys: string; what: string }> = [
  { keys: "↑ ↓ (← → in grid)", what: "moveCursor" },
  { keys: "Enter", what: "open" },
  { keys: "Backspace", what: "goUp" },
  { keys: "Esc", what: "cancel" },
  { keys: "Tab", what: "switchPane" },
  { keys: "Space", what: "quickLook" },
  { keys: "Ctrl/⌘+Space", what: "toggleSelect" },
  { keys: "Shift+Click", what: "rangeSelect" },
  { keys: "Ctrl/⌘+Click", what: "toggleClick" },
  { keys: "Drag on empty area", what: "marquee" },
  { keys: "Drag item", what: "dragOut" },
  { keys: "Ctrl/Shift before drag", what: "dragMove" },
];

export function ShortcutCheatsheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const all = useAllCommands();
  const bindings = useKeymap((s) => s.bindings);

  // 카테고리 → [label, key] (키 있는 command 만, 등록 순서 유지). 라벨/카테고리는
  // 렌더 시 t() 해석 — 언어 전환 즉시 반영.
  const byCategory = new Map<string, Array<{ label: string; key: string }>>();
  for (const cmd of all) {
    const key = effectiveKey(cmd.id, bindings, cmd.defaultKey);
    if (!key) continue;
    const list = byCategory.get(cmd.category) ?? [];
    list.push({ label: commandLabel(cmd, t), key });
    byCategory.set(cmd.category, list);
  }

  return (
    <DialogShell
      width="2xl"
      bodyFill
      divided
      title={t("cheatsheet.title")}
      subtitle={t("cheatsheet.customize")}
      description={t("cheatsheet.desc")}
      icon={Keyboard}
      onClose={onClose}
      footer={
        <DialogButton hint="esc" onClick={onClose}>
          {t("common.close")}
        </DialogButton>
      }
    >
      <div className="columns-2 gap-6 [column-fill:_balance]">
        <Section title={t("cheatsheet.basics")}>
          {BUILTIN_GESTURES.map((g) => (
            <Row
              key={g.keys}
              label={t(`cheatsheet.g.${g.what}`)}
              keys={g.keys}
              raw
            />
          ))}
        </Section>
        {[...byCategory.entries()].map(([category, cmds]) => (
          <Section key={category} title={commandCategory(category, t)}>
            {cmds.map((c) => (
              <Row key={c.label} label={c.label} keys={c.key} />
            ))}
          </Section>
        ))}
      </div>
    </DialogShell>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-4 break-inside-avoid">
      <h3 className="mb-1 text-meta font-medium uppercase tracking-wide text-fg-muted">
        {title}
      </h3>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function Row({
  label,
  keys,
  raw = false,
}: {
  label: string;
  keys: string;
  /** true 면 이미 표시용 문자열 — displayKey 변환 생략 (제스처 설명 등). */
  raw?: boolean;
}) {
  return (
    <li className="flex items-baseline justify-between gap-3 text-base">
      <span className="min-w-0 truncate">{label}</span>
      <kbd className="shrink-0 rounded bg-subtle px-1.5 py-0.5 font-mono text-meta text-fg-muted">
        {raw ? keys : displayKey(keys)}
      </kbd>
    </li>
  );
}
