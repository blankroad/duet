import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Lock, X } from "lucide-react";
import { vaultUnlock } from "@/stores/vault";

/**
 * Master password 프롬프트 — vault unlock (또는 신규 vault 생성).
 *
 * `mode === "create"` 면 새 vault 만들기 안내, `"unlock"` 이면 기존 unlock.
 * 둘 다 vaultUnlock IPC 한 번 호출 (백엔드는 파일 존재 여부에 따라 알아서 처리).
 *
 * CLAUDE.md §5 — input type=password, local state 만, 호출 직후 clear.
 */
export function MasterPasswordDialog({
  open,
  mode,
  onClose,
  onUnlocked,
}: {
  open: boolean;
  mode: "create" | "unlock";
  onClose: () => void;
  /** unlock 성공 후 호출 (caller 가 후속 작업 — vault_set 등). */
  onUnlocked: () => void;
}) {
  const [pw, setPw] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setPw("");
    setPwConfirm("");
    setError(null);
    setBusy(false);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!pw) {
      setError("Master password required");
      return;
    }
    if (mode === "create") {
      if (pw !== pwConfirm) {
        setError("Passwords do not match");
        return;
      }
      if (pw.length < 8) {
        setError("Master password must be at least 8 characters");
        return;
      }
    }
    setBusy(true);
    setError(null);
    const ok = await vaultUnlock(pw);
    setPw("");
    setPwConfirm("");
    setBusy(false);
    if (ok) {
      onUnlocked();
      onClose();
    } else {
      setError(mode === "create" ? "Failed to create vault" : "Wrong master password");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] w-full max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="flex items-center gap-2 text-title font-medium">
              <Lock size={14} />
              {mode === "create" ? "Create vault" : "Unlock vault"}
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          <p className="mb-3 text-meta text-fg-muted">
            {mode === "create"
              ? "비밀번호 vault 가 아직 없어요. 마스터 비밀번호를 정하면 saved hosts 의 password 가 암호화되어 저장됩니다 (age, scrypt+ChaCha20). 마스터를 잊으면 복구 불가."
              : "저장된 password 를 사용하려면 마스터 비밀번호를 입력하세요. 세션 동안 메모리에만 캐시됨."}
          </p>

          <input
            type="password"
            autoComplete="off"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) handleSubmit();
            }}
            placeholder="Master password"
            className="w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
          />
          {mode === "create" && (
            <input
              type="password"
              autoComplete="off"
              value={pwConfirm}
              onChange={(e) => setPwConfirm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) handleSubmit();
              }}
              placeholder="Confirm master password"
              className="mt-2 w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
            />
          )}

          {error && (
            <div className="mt-2 rounded border border-danger/50 bg-danger/10 p-2 text-meta text-danger">
              {error}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={busy}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              {busy ? "…" : mode === "create" ? "Create" : "Unlock"}
            </button>
          </div>

          <Dialog.Description className="sr-only">Master password prompt.</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
