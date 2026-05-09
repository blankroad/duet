import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  ctaLabel: string;
  ctaTone: "neutral" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  body,
  ctaLabel,
  ctaTone,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const ctaCls =
    ctaTone === "danger" ? "bg-danger text-white" : "bg-accent text-white";
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">{title}</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="text-base">{body}</div>
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
              className={`rounded px-3 py-1 text-base ${ctaCls}`}
            >
              {ctaLabel}
            </button>
          </div>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
