import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Lock, X } from "lucide-react";

/** submit 결과: "ok" = 닫기(성공 또는 caller 가 이미 처리), "retry" = 암호 틀림 → 재입력. */
export type PwSubmitResult = "ok" | "retry";

export interface PasswordPromptDialogProps {
  /** 표시용 아카이브 이름. */
  archiveName: string;
  /**
   * 입력 암호로 실제 작업을 시도. 성공/치명적 오류는 caller 가 처리하고 "ok"(닫기),
   * 암호가 틀린 경우(NeedPassword)만 "retry" 를 반환 — 그러면 다이얼로그가 열린 채
   * "wrong password" 를 보여주고 재입력을 받는다.
   */
  submit: (password: string) => Promise<PwSubmitResult>;
  onClose: () => void;
  /**
   * true = 직전 시도가 틀린 암호로 실패해서 다시 열림 — 처음부터 오류 메시지 표시.
   * (extract 처럼 결과가 task 이벤트로 오는 흐름은 "retry" 대신 재오픈으로 재시도.)
   */
  wrongPassword?: boolean | undefined;
}

/**
 * 암호 걸린 아카이브(zip)용 암호 프롬프트 — 해제(extract)와 열람(browse) 공용.
 *
 * CLAUDE.md §5 — input type=password(DOM 마스킹), 컴포넌트 local state 에만,
 * submit 호출 직후 즉시 clear. store/localStorage 등 영구화 안 함.
 */
export function PasswordPromptDialog({
  archiveName,
  submit,
  onClose,
  wrongPassword,
}: PasswordPromptDialogProps) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(
    wrongPassword ? "Wrong password — try again" : null,
  );
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setError(null);
    const r = await submit(pw);
    setPw(""); // §5: 호출 직후 즉시 clear
    setBusy(false);
    if (r === "ok") {
      onClose();
      return;
    }
    setError("Wrong password — try again");
    inputRef.current?.focus();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            // Radix 기본(첫 요소=닫기 버튼) 대신 암호 입력창으로 포커스.
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-[60] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="flex items-center gap-2 text-title font-medium">
              <Lock size={14} />
              Password required
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          <p
            className="mb-3 truncate text-meta text-fg-muted"
            title={archiveName}
          >
            {archiveName} is encrypted. Enter its password to continue.
          </p>

          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Archive password"
            className="w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
          />

          {error && (
            <div className="mt-2 rounded border border-danger/50 bg-danger/10 p-2 text-meta text-danger">
              {error}
            </div>
          )}

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
              onClick={() => void run()}
              disabled={busy || !pw}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              {busy ? "…" : "Continue"}
            </button>
          </div>

          <Dialog.Description className="sr-only">
            Enter the password for the encrypted archive {archiveName}.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
