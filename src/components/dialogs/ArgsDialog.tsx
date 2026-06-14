import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, Plus, Trash2 } from "lucide-react";

export interface ArgsDialogProps {
  /** 편집 대상 앱 이름 (표시용). */
  name: string;
  /** 현재 인자 목록. */
  initial: string[];
  onClose: () => void;
  onSubmit: (args: string[]) => void;
}

/**
 * 앱 실행 인자 편집 — 같은 앱을 다른 인자로 다른 동작. 행당 인자 1개(argv 배열이
 * 진실의 원천 — 셸 문자열 재분할 안 함, 인용 버그 회피).
 */
export function ArgsDialog({ name, initial, onClose, onSubmit }: ArgsDialogProps) {
  const [rows, setRows] = useState<string[]>(initial.length > 0 ? initial : [""]);

  const setRow = (i: number, v: string) => setRows((r) => r.map((x, j) => (j === i ? v : x)));
  const addRow = () => setRows((r) => [...r, ""]);
  const removeRow = (i: number) => setRows((r) => (r.length <= 1 ? [""] : r.filter((_, j) => j !== i)));
  const submit = () => onSubmit(rows.map((r) => r.trim()).filter((r) => r.length > 0));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">Arguments — {name}</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted hover:bg-border" aria-label="Close">
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="flex flex-col gap-1.5">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-1">
                <span className="w-5 text-right text-meta text-fg-muted">{i + 1}</span>
                <input
                  type="text"
                  value={r}
                  placeholder="argument"
                  autoFocus={i === rows.length - 1}
                  onChange={(e) => setRow(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                    else if (e.key === "Escape") onClose();
                  }}
                  className="min-w-0 flex-1 rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeRow(i)}
                  className="rounded p-1 text-fg-muted hover:bg-border hover:text-danger"
                  aria-label="Remove argument"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addRow}
            className="mt-2 flex items-center gap-1 rounded px-1 py-0.5 text-meta text-fg-muted hover:text-fg"
          >
            <Plus size={12} /> Add argument
          </button>
          <p className="mt-3 text-meta text-fg-muted">
            argv 배열로 그대로 전달 (셸 미경유). macOS GUI 앱 대부분은 인자를 무시하며 새
            인스턴스로 실행됩니다.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded bg-accent px-3 py-1 text-base text-white"
            >
              Save
            </button>
          </div>
          <Dialog.Description className="sr-only">Edit launch arguments for {name}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
