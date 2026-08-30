import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { vaultUnlock } from "@/stores/vault";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";
import { DialogBand } from "./DialogBand";

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
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      setError(t("dialog.masterPassword.errRequired"));
      return;
    }
    if (mode === "create") {
      if (pw !== pwConfirm) {
        setError(t("dialog.masterPassword.errMismatch"));
        return;
      }
      if (pw.length < 8) {
        setError(t("dialog.masterPassword.errShort"));
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
      setError(
        mode === "create"
          ? t("dialog.masterPassword.errCreateFailed")
          : t("dialog.masterPassword.errWrong"),
      );
    }
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !busy) void handleSubmit();
  };

  return (
    <DialogShell
      open={open}
      width="sm"
      layer="above"
      title={
        mode === "create"
          ? t("dialog.masterPassword.createTitle")
          : t("dialog.masterPassword.unlockTitle")
      }
      description={t("dialog.masterPassword.desc")}
      icon={Lock}
      onClose={handleClose}
      initialFocus={inputRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={handleClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="primary"
            hint="enter"
            disabled={busy}
            onClick={() => void handleSubmit()}
          >
            {busy
              ? "…"
              : mode === "create"
                ? t("dialog.masterPassword.create")
                : t("dialog.masterPassword.unlock")}
          </DialogButton>
        </>
      }
    >
      <p className="text-meta text-fg-muted">
        {mode === "create"
          ? t("dialog.masterPassword.createBody")
          : t("dialog.masterPassword.unlockBody")}
      </p>
      <DialogInput
        ref={inputRef}
        mono
        type="password"
        autoComplete="off"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={onEnter}
        placeholder={t("dialog.masterPassword.placeholder")}
      />
      {mode === "create" && (
        <DialogInput
          mono
          type="password"
          autoComplete="off"
          value={pwConfirm}
          onChange={(e) => setPwConfirm(e.target.value)}
          onKeyDown={onEnter}
          placeholder={t("dialog.masterPassword.confirmPlaceholder")}
        />
      )}
      {error && <DialogBand tone="danger" message={error} />}
    </DialogShell>
  );
}
