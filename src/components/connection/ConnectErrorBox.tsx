import { useTranslation } from "react-i18next";
import type { DuetError } from "@/types/bindings";
import { explainError } from "@/lib/error";

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
  // 제목이 이미 종류를 말하므로 상세는 원인 문장만 (제목과 겹치는 앞부분은 뺀다).
  // 백엔드 원문("… (os error 61)")은 마우스를 올리면 보인다(remote-26).
  const raw =
    "message" in error && typeof error.message === "string"
      ? error.message.trim()
      : "";
  const detail = raw ? withoutTitle(explainError(error).text, title) : null;
  return (
    <div
      role="alert"
      className="rounded-panel border border-danger/30 bg-danger/10 px-3 py-2 text-meta"
    >
      <div className="font-medium text-danger">{title}</div>
      {detail && (
        <div className="break-words text-fg-muted" title={raw}>
          {detail}
        </div>
      )}
      {error.kind === "AuthFailed" && (
        <div className="mt-1 text-fg-muted">{authHint}</div>
      )}
    </div>
  );
}

/** 원인 문장이 제목으로 시작하면("서버에 연결할 수 없습니다 — …") 그 부분을 뺀다. */
function withoutTitle(text: string, title: string): string | null {
  if (!text.startsWith(title)) return text;
  const rest = text.slice(title.length).replace(/^[\s—:.-]+/, "");
  return rest || null;
}
