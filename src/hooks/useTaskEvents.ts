import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";

/**
 * 백엔드 task-event 구독 + 부트스트랩.
 *
 * - 마운트 시 tasks_list 로 현재 큐 snapshot 받아 store init
 * - 종결 상태 (completed/cancelled/failed) 는 즉시 store 에서 remove —
 *   TasksBar 가 active 만 표시. history 보존은 후속 (MVP-7).
 *
 * 작업 완료 후 패널 새로고침은 여기서 하지 않는다 — 백엔드 `TaskQueue` 가 완료 시
 * affected 디렉토리로 `fs-changed-event` 를 emit 하고, `useFsChangedEvents` 가
 * 외부 변경과 동일한 경로로 새로고침한다. (in-app / 외부 변경 새로고침 일원화.)
 */
export function useTaskEvents() {
  const setAll = useTasks((s) => s.setAll);
  const add = useTasks((s) => s.add);
  const setStatus = useTasks((s) => s.setStatus);
  const setProgress = useTasks((s) => s.setProgress);
  const setError = useTasks((s) => s.setError);
  const remove = useTasks((s) => s.remove);

  useEffect(() => {
    let cancelled = false;
    commands.tasksList().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setAll(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [setAll]);

  useEffect(() => {
    const unlistenP = events.taskEvent.listen(({ payload }) => {
      const id = payload.task_id;
      switch (payload.change.kind) {
        case "enqueued":
          add(payload.change.task);
          break;
        case "started":
          setStatus(id, { kind: "running" });
          break;
        case "progress":
          setProgress(id, payload.change.progress);
          break;
        case "completed":
          setStatus(id, {
            kind: "completed",
            journal_id: payload.change.journal_id,
          });
          remove(id);
          break;
        case "cancelled":
          setStatus(id, { kind: "cancelled" });
          remove(id);
          break;
        case "failed":
          setError(id, payload.change.message);
          setStatus(id, { kind: "failed", message: payload.change.message });
          // 백그라운드 task(복사/이동/삭제 등) 실패는 지금까지 store 에서 즉시 remove
          // 돼 UI 에 전혀 안 보였다 — 파괴적 작업의 조용한 실패는 위험. 토스트로 표면화.
          useToast
            .getState()
            .show(`Operation failed — ${payload.change.message}`);
          remove(id);
          break;
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [add, setStatus, setProgress, setError, remove]);
}
