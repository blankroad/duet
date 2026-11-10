import { PasswordPromptDialog } from "./PasswordPromptDialog";
import { retryExtract } from "@/lib/extractActions";
import {
  closeExtractPrompt,
  retryArchiveName,
  type ExtractRetry,
} from "@/lib/extractPending";
import { showError } from "@/lib/errorToast";

export interface ExtractPasswordPromptProps {
  prompt: {
    promptId: string;
    retry: ExtractRetry;
    wrong?: boolean | undefined;
  };
}

/**
 * 압축 해제 암호 창 — 대기열(extractPending)의 프롬프트 하나.
 *
 * 부르는 쪽은 `key={prompt.promptId}` 로 그린다: 다음 아카이브로 넘어가면 창이 새로
 * 만들어져 입력한 암호·오류·진행 상태가 이어지지 않는다(아카이브 사이 암호 재사용 없음,
 * CLAUDE.md §5). 닫기는 이 프롬프트가 아직 떠 있을 때만 — 취소 뒤에 늦게 끝난 제출이
 * 다음 아카이브의 창을 닫지 못한다.
 */
export function ExtractPasswordPrompt({ prompt }: ExtractPasswordPromptProps) {
  const name = retryArchiveName(prompt.retry);
  return (
    <PasswordPromptDialog
      archiveName={name}
      wrongPassword={prompt.wrong}
      // 닫히면(입력·취소) extractPending 의 대기열이 다음 아카이브의 창을 연다.
      onClose={() => closeExtractPrompt(prompt.promptId)}
      submit={async (pw) => {
        // 커맨드는 task enqueue 후 TaskId 를 즉시 반환 — 암호가 틀리면 task 가
        // NeedPassword 로 실패하고 대기열이 이 아카이브의 새 프롬프트를 연다.
        const r = await retryExtract(prompt.retry, pw);
        if (!r.ok) showError("toast.extractFailed", r.error, { path: name });
        return "ok";
      }}
    />
  );
}
