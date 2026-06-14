import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { CompressFormat } from "@/types/bindings";

export interface CompressDialogProps {
  /** 압축 대상 항목 수 (본문 표시용). */
  itemCount: number;
  /** 기본 아카이브 이름 (확장자 제외). */
  defaultName: string;
  onClose: () => void;
  onSubmit: (name: string, format: CompressFormat) => void;
}

const FORMATS: { value: CompressFormat; label: string }[] = [
  { value: "zip", label: ".zip" },
  { value: "tar_gz", label: ".tar.gz" },
];

export function CompressDialog({ itemCount, defaultName, onClose, onSubmit }: CompressDialogProps) {
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState<CompressFormat>("zip");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed, format);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">Compress</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted hover:bg-border" aria-label="Close">
              <X size={14} />
            </Dialog.Close>
          </div>
          <div className="mb-2 text-meta text-fg-muted">
            {itemCount} item{itemCount === 1 ? "" : "s"} → archive
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder="archive name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onClose();
            }}
            className="w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
          />
          <div className="mt-3 flex gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFormat(f.value)}
                className={
                  "rounded border px-3 py-1 font-mono text-base " +
                  (format === f.value
                    ? "border-accent bg-accent/10 text-fg"
                    : "border-border text-fg-muted hover:bg-subtle")
                }
              >
                {f.label}
              </button>
            ))}
          </div>
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
              Compress
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Compress {itemCount} item(s) into an archive
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
