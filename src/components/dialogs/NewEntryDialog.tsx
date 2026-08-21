import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { Location } from "@/types/bindings";

export interface NewEntryDialogProps {
  /** 만들 대상 — 제목/플레이스홀더만 갈리고 나머지 UI 는 동일. */
  kind: "dir" | "file";
  parent: Location;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

/** 활성 폴더에 새 폴더 / 새 빈 파일을 만드는 이름 입력 다이얼로그. */
export function NewEntryDialog({
  kind,
  parent,
  onClose,
  onSubmit,
}: NewEntryDialogProps) {
  const { t } = useTranslation();
  // i18n 키 묶음만 교체 — 두 묶음의 하위 키(title/in/placeholder/create/desc) 동일.
  const k = kind === "dir" ? "mkdir" : "newFile";
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            // Radix 기본(첫 요소=닫기 버튼) 대신 입력창으로 포커스.
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">
              {t(`dialog.${k}.title`)}
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
            title={parent.path}
          >
            {t(`dialog.${k}.in`, { path: parent.path })}
          </div>
          <input
            ref={inputRef}
            type="text"
            value={name}
            placeholder={t(`dialog.${k}.placeholder`)}
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
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!name.trim()}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              {t(`dialog.${k}.create`)}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            {t(`dialog.${k}.desc`, { path: parent.path })}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
