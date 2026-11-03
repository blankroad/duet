import { useTranslation } from "react-i18next";
import type { DuetError } from "@/types/bindings";

/**
 * 연결 실패 안내 — 연결/ad-hoc 대화상자 공용.
 *
 * 예전엔 제목 자리에 `AuthFailed` 같은 내부 kind 를 그대로 보여 줬다. 사람이 읽는
 * 제목(무엇이 실패했나) + 백엔드 상세(있으면) + 인증 실패면 다음 행동 힌트.
 */
export function ConnectErrorBox({
  error,
  authHint,
}: {
  error: DuetError;
  /** AuthFailed 일 때 붙일 다음 행동 안내 (대화상자마다 문구가 다르다). */
  authHint: string;
}) {
  const { t } = useTranslation();
  const title = t(`dialog.connection.errorTitle.${error.kind}`, {
    defaultValue: t("dialog.connection.errorTitle.default"),
  });
  // 제목이 이미 종류를 말하므로 상세는 백엔드 메시지만 (라벨 중복 없이).
  const detail =
    "message" in error && typeof error.message === "string"
      ? error.message.trim() || null
      : null;
  return (
    <div
      role="alert"
      className="rounded-panel border border-danger/30 bg-danger/10 px-3 py-2 text-meta"
    >
      <div className="font-medium text-danger">{title}</div>
      {detail && <div className="break-words text-fg-muted">{detail}</div>}
      {error.kind === "AuthFailed" && (
        <div className="mt-1 text-fg-muted">{authHint}</div>
      )}
    </div>
  );
}
