import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";

/**
 * 원격 sudo 비밀번호 입력 — CLAUDE.md §5: `<input type=password>`, 컴포넌트 local
 * state 만, store/localStorage 금지, 제출/취소 즉시 clear. 백엔드는 stdin 으로만 전달.
 */
export function SudoPasswordDialog({
  dest,
  error,
  onCancel,
  onConfirm,
}: {
  dest: string;
  error?: boolean;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const submit = () => {
    const pw = password;
    setPassword(""); // §5: 즉시 clear
    onConfirm(pw);
  };
  const cancel = () => {
    setPassword("");
    onCancel();
  };
  return (
    <Dialog.Root open onOpenChange={(o) => !o && cancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <Dialog.Title className="mb-2 text-title font-medium">
            {t("dialog.sudoPassword.title")}
          </Dialog.Title>
          <div className="mb-2 text-base">
            <Trans
              i18nKey="dialog.sudoPassword.body"
              values={{ dest }}
              components={{ 1: <span className="break-all font-mono" /> }}
            />
          </div>
          {error && (
            <div className="mb-2 text-meta text-danger">
              {t("dialog.sudoPassword.wrong")}
            </div>
          )}
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            placeholder={t("dialog.sudoPassword.placeholder")}
            aria-label={t("dialog.sudoPassword.placeholder")}
            className="w-full rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded bg-accent px-3 py-1 text-base text-white"
            >
              {t("dialog.sudoPassword.cta")}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            {t("dialog.sudoPassword.desc")}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
