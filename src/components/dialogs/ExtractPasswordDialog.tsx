import { useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Lock, X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ExtractPlan } from "@/types/bindings";
import { formatErr } from "@/lib/error";

export interface ExtractPasswordDialogProps {
  plan: ExtractPlan;
  onClose: () => void;
  showToast: (msg: string) => void;
}

/**
 * 암호 걸린 zip 해제용 암호 프롬프트.
 *
 * 백엔드가 NeedPassword 를 반환하면 열리고, 입력한 암호로 fs_extract_execute 를 재호출.
 * 또 틀리면(NeedPassword 재반환) 그대로 열린 채 "wrong password" 표시하고 재입력 받음.
 * 성공(task enqueue)하면 닫힘 — 진행은 TasksBar 가 보여준다.
 *
 * CLAUDE.md §5 — input type=password(DOM 마스킹), 컴포넌트 local state 에만,
 * command 호출 직후 즉시 clear. store/localStorage 등 영구화 안 함.
 */
export function ExtractPasswordDialog({
  plan,
  onClose,
  showToast,
}: ExtractPasswordDialogProps) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setError(null);
    const r = await commands.fsExtractExecute(plan, pw);
    setPw(""); // §5: 호출 직후 즉시 clear
    setBusy(false);
    if (r.status === "ok") {
      onClose();
      return;
    }
    if (r.error.kind === "NeedPassword") {
      setError("Wrong password — try again");
      inputRef.current?.focus();
      return;
    }
    showToast(`Extract failed: ${formatErr(r.error)}`);
    onClose();
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
            title={plan.archive_name}
          >
            {plan.archive_name} is encrypted. Enter its password to extract.
          </p>

          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
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
              onClick={() => void submit()}
              disabled={busy || !pw}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              {busy ? "…" : "Extract"}
            </button>
          </div>

          <Dialog.Description className="sr-only">
            Enter the password for the encrypted archive {plan.archive_name}.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
