import type {
  CopyPlan,
  MovePlan,
  DeletePlan,
  ConflictPolicy,
} from "@/types/bindings";

/**
 * 복사/이동/삭제 task 가 `PermissionDenied` 로 실패했을 때 **승격 재시도**(로컬 UAC /
 * 원격 sudo)를 하려면 원본 plan 이 필요한데, 이들은 백그라운드 task 라 실패 이벤트엔
 * 메시지만 온다. 그래서 enqueue 시점에 taskId 로 기억해 뒀다가 꺼내 재시도한다.
 *
 * 리액티브 불필요 — `useTaskEvents` 가 imperatively 조회. 완료/취소/실패 시 반드시 take.
 */
export type ElevatablePlan =
  | { op: "copy"; plan: CopyPlan; policy: ConflictPolicy }
  | { op: "move"; plan: MovePlan; policy: ConflictPolicy }
  // confirmWord: 영구삭제(§3) 단어-타이핑 확인. 승격 재시도 시 백엔드가 재검증하므로
  // 최초 삭제에서 사용자가 입력한 값을 함께 보관한다(휴지통 삭제는 빈 문자열).
  | { op: "delete"; plan: DeletePlan; confirmWord: string };

const pending = new Map<string, ElevatablePlan>();

export function rememberElevatable(taskId: string, item: ElevatablePlan): void {
  pending.set(taskId, item);
  if (pending.size > 50) {
    const first = pending.keys().next().value;
    if (first !== undefined) pending.delete(first);
  }
}

export function takeElevatable(taskId: string): ElevatablePlan | null {
  const v = pending.get(taskId) ?? null;
  pending.delete(taskId);
  return v;
}

/** 승격 대상 목적지의 소스 종류 (SSH→sudo, local→UAC 라우팅용). */
export function elevatableDestKind(e: ElevatablePlan): "local" | "ssh" {
  return e.op === "delete" ? e.plan.source.kind : e.plan.dst.source.kind;
}

/** 다이얼로그에 표시할 대상 경로 (copy/move=dst, delete=원본 위치). */
export function elevatableDestPath(e: ElevatablePlan): string {
  return e.op === "delete" ? e.plan.source_location.path : e.plan.dst.path;
}
