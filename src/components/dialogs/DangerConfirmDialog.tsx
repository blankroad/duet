import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

export interface DangerConfirmDialogProps {
  title: string;
  body: ReactNode;
  requiredWord: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DangerConfirmDialog({
  title,
  body,
  requiredWord,
  onCancel,
  onConfirm,
}: DangerConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const enabled = typed === requiredWord;
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border-2 border-danger bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="flex items-center gap-2 text-title font-medium text-danger">
              <AlertTriangle size={16} />
              {title}
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="text-base">{body}</div>
          <div className="mt-3">
            <div className="mb-1 text-meta text-fg-muted">
              Type <span className="font-mono text-fg">{requiredWord}</span> to confirm:
            </div>
            <input
              ref={inputRef}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && enabled) onConfirm();
                else if (e.key === "Escape") onCancel();
              }}
              className="w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-danger focus:outline-none"
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!enabled}
              className="rounded bg-danger px-3 py-1 text-base text-white disabled:opacity-30"
            >
              Delete
            </button>
          </div>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
