import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { usePromptDialog } from "@/stores/promptDialog";

/**
 * window.prompt 대체 인풋 다이얼로그 렌더러 — App 루트에 1개 마운트.
 * Enter/OK = 확정, Esc/취소/닫기 = null. 열릴 때 초기값 전체 선택.
 */
export function PromptDialogHost() {
  const { t } = useTranslation();
  const req = usePromptDialog((s) => s.req);
  const settle = usePromptDialog((s) => s.settle);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (req) setValue(req.initial ?? "");
  }, [req]);

  if (!req) return null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && settle(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
            inputRef.current?.select();
          }}
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="text-base font-medium">
              {req.title}
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label={t("common.close")}
            >
              <X size={14} />
            </Dialog.Close>
          </div>
          <input
            ref={inputRef}
            type="text"
            value={value}
            placeholder={req.placeholder}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                settle(value);
              }
            }}
            className="w-full rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => settle(null)}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={() => settle(value)}
              className="rounded bg-accent px-3 py-1 text-base text-white"
            >
              {t("common.ok")}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            {req.title}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
