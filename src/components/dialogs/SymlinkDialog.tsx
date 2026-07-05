import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { Location } from "@/types/bindings";

export interface SymlinkDialogProps {
  parent: Location;
  onClose: () => void;
  onSubmit: (name: string, target: string) => void;
}

/**
 * 심볼릭 링크 생성 — 링크 이름 + 대상 경로(상대/절대 그대로, 존재 검증 안 함 —
 * 의도적 dangling 링크 허용). undo 는 링크 제거.
 */
export function SymlinkDialog({
  parent,
  onClose,
  onSubmit,
}: SymlinkDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const canSubmit = name.trim() !== "" && target.trim() !== "";
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(name.trim(), target.trim());
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">
              {t("dialog.symlink.title")}
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label={t("common.close")}
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <div
            className="mb-2 truncate text-meta text-fg-muted"
            title={String(parent.path)}
          >
            {t("dialog.symlink.in", { path: String(parent.path) })}
          </div>
          <input
            ref={nameRef}
            type="text"
            value={name}
            placeholder={t("dialog.symlink.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              else if (e.key === "Escape") onClose();
            }}
            className="mb-2 w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
          />
          <input
            type="text"
            value={target}
            placeholder={t("dialog.symlink.targetPlaceholder")}
            spellCheck={false}
            onChange={(e) => setTarget(e.target.value)}
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
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              {t("dialog.symlink.create")}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            {t("dialog.symlink.desc", { path: String(parent.path) })}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
