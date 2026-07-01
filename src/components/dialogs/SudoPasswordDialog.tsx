import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";

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
          <Dialog.Title className="mb-2 text-title font-medium">sudo password</Dialog.Title>
          <div className="mb-2 text-base">
            Enter your sudo password to copy to{" "}
            <span className="break-all font-mono">{dest}</span>.
          </div>
          {error && (
            <div className="mb-2 text-meta text-danger">Incorrect password — try again.</div>
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
            placeholder="sudo password"
            aria-label="sudo password"
            className="w-full rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="rounded bg-accent px-3 py-1 text-base text-white"
            >
              Continue
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Enter sudo password for remote elevated copy
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
