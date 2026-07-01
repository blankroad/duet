import type { CopyPlan, ConflictPolicy } from "@/types/bindings";

/**
 * 복사 task 가 `PermissionDenied` 로 실패했을 때 **관리자 승격 재시도**를 하려면 원본
 * CopyPlan+policy 가 필요한데, 복사는 백그라운드 task 라 실패 이벤트에는 메시지만 온다.
 * 그래서 enqueue 시점에 taskId 로 기억해 뒀다가, 실패 이벤트에서 꺼내 재시도한다.
 *
 * 리액티브 불필요 — `useTaskEvents` 가 imperatively 조회. 완료/취소/실패 시 반드시 take
 * 해 정리(누수 방지 + 캡).
 */
const pending = new Map<string, { plan: CopyPlan; policy: ConflictPolicy }>();

export function rememberElevatable(
  taskId: string,
  plan: CopyPlan,
  policy: ConflictPolicy,
): void {
  pending.set(taskId, { plan, policy });
  // 누수 방지 캡 — 오래된 것부터 버림.
  if (pending.size > 50) {
    const first = pending.keys().next().value;
    if (first !== undefined) pending.delete(first);
  }
}

export function takeElevatable(
  taskId: string,
): { plan: CopyPlan; policy: ConflictPolicy } | null {
  const v = pending.get(taskId) ?? null;
  pending.delete(taskId);
  return v;
}
