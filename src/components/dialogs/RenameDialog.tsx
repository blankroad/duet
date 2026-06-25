import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { EntryRef } from "@/types/bindings";

export interface RenameDialogProps {
  target: EntryRef;
  onClose: () => void;
  onSubmit: (newName: string) => void;
}

export function RenameDialog({ target, onClose, onSubmit }: RenameDialogProps) {
  const [name, setName] = useState(target.name);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === target.name) {
      onClose();
      return;
    }
    onSubmit(trimmed);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            // 입력창 포커스 + basename(확장자 앞)만 선택. Radix 기본(닫기 버튼) 대체.
            e.preventDefault();
            const t = inputRef.current;
            if (!t) return;
            t.focus();
            const dot = target.name.lastIndexOf(".");
            if (dot > 0) t.setSelectionRange(0, dot);
            else t.select();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">Rename</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
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
              className="rounded bg-accent px-3 py-1 text-base text-white"
            >
              Rename
            </button>
          </div>
          <Dialog.Description className="sr-only">Rename {target.name}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
