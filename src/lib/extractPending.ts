import type { EntryRef, ExtractConflict, ExtractPlan } from "@/types/bindings";
import { useUIDialogs } from "@/stores/ui-dialogs";

/**
 * 암호가 필요할 때 같은 해제를 다시 거는 방법 — 폴더로 풀기는 받은 plan 그대로,
 * 여기에 풀기는 같은 아카이브·같은 충돌 정책으로.
 */
export type ExtractRetry =
  | { kind: "folder"; plan: ExtractPlan }
  | {
      kind: "here";
      archive: EntryRef;
      policy: ExtractConflict;
      /** 처음 일괄의 아카이브들 — 재시도에서도 형제 원본을 Replace 에서 보호(BE 가 재확인). */
      batch: EntryRef[];
    };

/** 표시용 아카이브 이름. */
export function retryArchiveName(r: ExtractRetry): string {
  return r.kind === "folder" ? r.plan.archive_name : r.archive.name;
}

/**
 * 압축 해제 task 가 `NeedPassword` 로 실패했을 때 암호 다이얼로그로 재시도하려면
 * enqueue 시점의 재시도 정보가 필요한데, 해제는 백그라운드 task 라 실패가 task
 * 이벤트로만 온다. 그래서 enqueue 시 taskId 로 기억해 뒀다가 `useTaskEvents` 가
 * 꺼내 쓴다. (elevatePending 과 같은 패턴 — 리액티브 불필요, 종결 시 반드시 take.)
 */
export interface PendingExtract {
  retry: ExtractRetry;
  /** true = 이미 암호를 입력하고 실패 — 다이얼로그에 "wrong password" 표시. */
  attempted: boolean;
}

const pending = new Map<string, PendingExtract>();

export function rememberExtract(taskId: string, item: PendingExtract): void {
  pending.set(taskId, item);
  if (pending.size > 50) {
    const first = pending.keys().next().value;
    if (first !== undefined) pending.delete(first);
  }
}

export function takeExtract(taskId: string): PendingExtract | null {
  const v = pending.get(taskId) ?? null;
  pending.delete(taskId);
  return v;
}

/**
 * 암호 프롬프트 대기열 (FIFO) — 여러 암호 아카이브를 한 번에 풀면 NeedPassword 가
 * 여럿 온다. 암호 창은 한 번에 하나만 띄우고, 그 창이 닫히면(입력·취소 모두) 다음
 * 아카이브의 창을 연다. 취소는 그 아카이브만 건너뛴다. 암호는 아카이브마다 따로 묻는다
 * (아카이브 사이 재사용 없음). 암호 자체는 여기 없다 — 다이얼로그 local state 에만(§5).
 */
export interface PasswordPrompt {
  retry: ExtractRetry;
  /** 직전에 입력한 암호가 틀려 다시 묻는 것. */
  wrong: boolean;
}

const waiting: PasswordPrompt[] = [];
let watching = false;
/** 프롬프트마다 새 id — 같은 이름의 아카이브 둘도 서로 다른 창(React key)이 된다. */
let promptSeq = 0;

/** 암호 창이 지금 떠 있거나 대화상자 대기열에 들어가 있는가. */
function promptInFlight(): boolean {
  const s = useUIDialogs.getState();
  return (
    s.dialog.kind === "extract-password" ||
    s.queue.some((d) => d.kind === "extract-password")
  );
}

/** 다음 프롬프트를 연다. 반환 = 바로 보였는가 (false = 다른 창 뒤 대기열). */
function showNext(): boolean {
  const next = waiting.shift();
  if (!next) return true;
  promptSeq += 1;
  return useUIDialogs.getState().openWhenFree({
    kind: "extract-password",
    promptId: `extract-password-${promptSeq}`,
    retry: next.retry,
    wrong: next.wrong,
  });
}

/**
 * 그 프롬프트가 아직 떠 있을 때만 닫는다. 이미 닫히고 다음 아카이브의 창이 떴는데
 * 늦게 끝난 제출(암호 재시도)이 닫기를 부르면, 다음 창을 닫지 않게 한다.
 */
export function closeExtractPrompt(promptId: string): void {
  const s = useUIDialogs.getState();
  if (s.dialog.kind === "extract-password" && s.dialog.promptId === promptId)
    s.close();
}

/**
 * 암호 창이 닫힐 때마다(입력·취소·다른 창이 덮음 — 어떤 경로든) 다음 차례를 연다.
 * App 의 닫기 경로마다 손대지 않도록 대화상자 store 를 구독한다. 첫 요청 때 한 번 건다.
 */
function watchDialogs(): void {
  if (watching) return;
  watching = true;
  useUIDialogs.subscribe(() => {
    if (waiting.length > 0 && !promptInFlight()) showNext();
  });
}

/**
 * NeedPassword 로 실패한 해제를 암호 대기열에 넣는다. 반환 = false 면 사용과 무관한
 * 다른 대화상자 뒤에 줄을 섰다는 뜻 — 호출부가 "기다리는 작업 있음" 을 알린다.
 * 다른 아카이브의 암호 창 뒤에 선 경우는 true (따로 알릴 필요 없음).
 */
export function requestExtractPassword(p: PasswordPrompt): boolean {
  watchDialogs();
  waiting.push(p);
  if (promptInFlight()) return true;
  return showNext();
}

/** 아직 창을 기다리는 암호 프롬프트 수 (지금 떠 있는 것 제외). */
export function waitingPasswordCount(): number {
  return waiting.length;
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetExtractPendingForTest(): void {
  pending.clear();
  waiting.length = 0;
}
