import { useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Lock } from "lucide-react";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";
import { DialogBand } from "./DialogBand";

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
  error?: boolean | undefined;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
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
    <DialogShell
      title={t("dialog.sudoPassword.title")}
      description={t("dialog.sudoPassword.desc")}
      icon={Lock}
      onClose={cancel}
      initialFocus={inputRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={cancel}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton tone="primary" hint="enter" onClick={submit}>
            {t("dialog.sudoPassword.cta")}
          </DialogButton>
        </>
      }
    >
      <div>
        <Trans
          i18nKey="dialog.sudoPassword.body"
          values={{ dest }}
          components={{ 1: <span className="break-all font-mono" /> }}
        />
      </div>
      {error && (
        <DialogBand tone="danger" message={t("dialog.sudoPassword.wrong")} />
      )}
      <DialogInput
        ref={inputRef}
        type="password"
        autoComplete="off"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("dialog.sudoPassword.placeholder")}
        aria-label={t("dialog.sudoPassword.placeholder")}
      />
    </DialogShell>
  );
}
