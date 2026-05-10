import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import { useTasks } from "@/stores/tasks";

/**
 * 백엔드 task-event 구독 + 부트스트랩.
 *
 * - 마운트 시 tasks_list 로 현재 큐 snapshot 받아 store init
 * - 이후 TaskEvent 수신:
 *   - Enqueued{task} → add
 *   - Started → setStatus running
 *   - Progress{progress} → setProgress
 *   - Completed{journal_id} → setStatus completed → remove (즉시)
 *   - Cancelled → setStatus cancelled → remove
 *   - Failed{message} → setStatus failed + setError → remove
 *
 * 종결 상태 (completed/cancelled/failed) 는 즉시 store 에서 remove —
 * TasksBar 가 active 만 표시. history 보존은 후속 (MVP-7).
 */
export function useTaskEvents() {
  const setAll = useTasks((s) => s.setAll);
  const add = useTasks((s) => s.add);
  const setStatus = useTasks((s) => s.setStatus);
  const setProgress = useTasks((s) => s.setProgress);
  const setError = useTasks((s) => s.setError);
  const remove = useTasks((s) => s.remove);

  // bootstrap
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

  // live subscribe
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
          setStatus(id, { kind: "completed", journal_id: payload.change.journal_id });
          remove(id);
          break;
        case "cancelled":
          setStatus(id, { kind: "cancelled" });
          remove(id);
          break;
        case "failed":
          setError(id, payload.change.message);
          setStatus(id, { kind: "failed", message: payload.change.message });
          remove(id);
          break;
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [add, setStatus, setProgress, setError, remove]);
}
