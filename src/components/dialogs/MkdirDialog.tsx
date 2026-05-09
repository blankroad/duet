import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { Location } from "@/types/bindings";

export interface MkdirDialogProps {
  parent: Location;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

export function MkdirDialog({ parent, onClose, onSubmit }: MkdirDialogProps) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">New folder</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="mb-2 truncate text-meta text-fg-muted" title={parent.path}>
            in {parent.path}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder="folder name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onClose();
            }}
            className="w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
          />
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
              disabled={!name.trim()}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              Create
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Create new folder in {parent.path}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
