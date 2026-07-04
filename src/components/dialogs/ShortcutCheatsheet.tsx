import * as Dialog from "@radix-ui/react-dialog";
import { X, Keyboard } from "lucide-react";
import { useAllCommands } from "@/stores/commands";
import { useKeymap, effectiveKey } from "@/stores/keymap";
import { displayKey } from "@/lib/keyDisplay";

/**
 * 단축키 치트시트 (F1) — 카테고리별 command 단축키(리바인드 반영) +
 * command 가 아닌 내장 제스처(화살표/드래그 수식키 등) 안내.
 *
 * 발견 가능성 보완용 읽기 전용 뷰 — 편집은 Settings › Keymap 에서.
 */

/** command 로 등록되지 않은 내장 키/제스처 — useKeyboardNav·DnD 하드와이어드. */
const BUILTIN_GESTURES: Array<{ keys: string; what: string }> = [
  { keys: "↑ ↓ (← → in grid)", what: "Move cursor" },
  { keys: "Enter", what: "Open item" },
  { keys: "Backspace", what: "Go up / leave archive" },
  { keys: "Tab", what: "Switch pane" },
  { keys: "Space", what: "Quick Look preview" },
  { keys: "Ctrl/⌘+Space", what: "Toggle select at cursor" },
  { keys: "Shift+Click", what: "Select range" },
  { keys: "Ctrl/⌘+Click", what: "Toggle select" },
  { keys: "Drag on empty area", what: "Marquee select" },
  { keys: "Drag item", what: "Copy out to OS / other pane" },
  { keys: "Ctrl/Shift before drag", what: "Move instead of copy (local)" },
];

export function ShortcutCheatsheet({ onClose }: { onClose: () => void }) {
  const all = useAllCommands();
  const bindings = useKeymap((s) => s.bindings);

  // 카테고리 → [label, key] (키 있는 command 만, 등록 순서 유지).
  const byCategory = new Map<string, Array<{ label: string; key: string }>>();
  for (const cmd of all) {
    const key = effectiveKey(cmd.id, bindings, cmd.defaultKey);
    if (!key) continue;
    const list = byCategory.get(cmd.category) ?? [];
    list.push({ label: cmd.label, key });
    byCategory.set(cmd.category, list);
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Keyboard size={15} className="text-fg-muted" aria-hidden />
            <Dialog.Title className="text-title font-medium">
              Keyboard shortcuts
            </Dialog.Title>
            <span className="ml-2 text-meta text-fg-muted">
              Customize in Settings › Keymap
            </span>
            <Dialog.Close asChild>
              <button
                type="button"
                className="ml-auto rounded p-1 text-fg-muted hover:bg-border"
                aria-label="Close"
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="columns-2 gap-6 [column-fill:_balance]">
              <Section title="Basics">
                {BUILTIN_GESTURES.map((g) => (
                  <Row key={g.keys} label={g.what} keys={g.keys} raw />
                ))}
              </Section>
              {[...byCategory.entries()].map(([category, cmds]) => (
                <Section key={category} title={category}>
                  {cmds.map((c) => (
                    <Row key={c.label} label={c.label} keys={c.key} />
                  ))}
                </Section>
              ))}
            </div>
          </div>
          <Dialog.Description className="sr-only">
            Keyboard shortcut reference
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
