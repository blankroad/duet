import type { ExtractPlan } from "@/types/bindings";

/**
 * 압축 해제 task 가 `NeedPassword` 로 실패했을 때 암호 다이얼로그로 재시도하려면
 * enqueue 시점의 plan 이 필요한데, 해제는 백그라운드 task 라 실패가 task 이벤트로만
 * 온다. 그래서 enqueue 시 taskId 로 기억해 뒀다가 `useTaskEvents` 가 꺼내 쓴다.
 * (elevatePending 과 같은 패턴 — 리액티브 불필요, 종결 시 반드시 take.)
 */
export interface PendingExtract {
  plan: ExtractPlan;
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
