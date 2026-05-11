import { useEffect, useRef, useState } from "react";
import { useAllCommands } from "@/stores/commands";
import { useKeymap, setKeymap, unsetKeymap } from "@/stores/keymap";
import { formatKeyEvent } from "@/lib/keyEvent";
import { AlertTriangle } from "lucide-react";

export function KeymapSection() {
  const all = useAllCommands();
  const bindings = useKeymap((s) => s.bindings);
  const [editing, setEditing] = useState<string | null>(null);

  // 충돌 감지: key → count
  const keyCount: Record<string, number> = {};
  for (const c of all) {
    const bound = bindings.find((b) => b.command_id === c.id);
    const key = bound?.key ?? c.defaultKey;
    if (key) keyCount[key] = (keyCount[key] ?? 0) + 1;
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[1fr_5rem_8rem_5rem] gap-2 border-b border-border px-2 py-1 text-meta text-fg-muted">
        <div>Command</div>
        <div>Category</div>
        <div>Key</div>
        <div>Actions</div>
      </div>
      {all.map((cmd) => {
        const bound = bindings.find((b) => b.command_id === cmd.id);
        const key = bound?.key ?? cmd.defaultKey;
        const conflict = key && keyCount[key]! > 1;
        return (
          <div
            key={cmd.id}
            className="grid grid-cols-[1fr_5rem_8rem_5rem] items-center gap-2 px-2 py-0.5 text-base hover:bg-subtle"
          >
            <div className="truncate" title={cmd.id}>{cmd.label}</div>
            <div className="text-meta text-fg-muted">{cmd.category}</div>
            <div>
              {editing === cmd.id ? (
                <KeyCaptureInput
                  onCancel={() => setEditing(null)}
                  onCapture={async (newKey) => {
                    await setKeymap(newKey, cmd.id);
                    setEditing(null);
                  }}
                />
              ) : (
                <span className="flex items-center gap-1 font-mono text-meta">
                  {key ?? <span className="text-fg-muted">(none)</span>}
                  {conflict && <AlertTriangle size={11} className="text-danger" />}
                </span>
              )}
            </div>
            <div className="flex gap-1 text-meta">
              <button
                type="button"
                onClick={() => setEditing(cmd.id)}
                className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-border hover:text-fg"
              >
                Edit
              </button>
              {bound && (
                <button
                  type="button"
                  onClick={() => void unsetKeymap(bound.key)}
                  className="rounded px-1.5 py-0.5 text-fg-muted hover:bg-border hover:text-fg"
                >
                  Reset
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function KeyCaptureInput({
  onCancel,
  onCapture,
}: {
  onCancel: () => void;
  onCapture: (key: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      readOnly
      value=""
      placeholder="Press key…"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
          return;
        }
        const ks = formatKeyEvent(e.nativeEvent);
        if (ks) {
          e.preventDefault();
          onCapture(ks);
        }
      }}
      onBlur={onCancel}
      className="w-full rounded border border-accent bg-subtle px-2 py-0.5 font-mono text-meta focus:outline-none"
    />
  );
}
