import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";
import { DialogBand } from "./DialogBand";

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
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [error, setError] = useState<string | null>(
    wrongPassword ? t("dialog.passwordPrompt.wrong") : null,
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
    setError(t("dialog.passwordPrompt.wrong"));
    inputRef.current?.focus();
  };

  return (
    <DialogShell
      width="sm"
      layer="above"
      title={t("dialog.passwordPrompt.title")}
      subtitle={
        <span title={archiveName}>
          {t("dialog.passwordPrompt.body", { name: archiveName })}
        </span>
      }
      description={t("dialog.passwordPrompt.desc", { name: archiveName })}
      icon={Lock}
      onClose={onClose}
      initialFocus={inputRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="primary"
            hint="enter"
            disabled={busy || !pw}
            onClick={() => void run()}
          >
            {busy ? "…" : t("dialog.passwordPrompt.cta")}
          </DialogButton>
        </>
      }
    >
      <DialogInput
        ref={inputRef}
        mono
        type="password"
        autoComplete="off"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void run();
        }}
        placeholder={t("dialog.passwordPrompt.placeholder")}
      />
      {error && <DialogBand tone="danger" message={error} />}
    </DialogShell>
  );
}
