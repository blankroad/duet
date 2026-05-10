import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import type { Location } from "@/types/bindings";
import { useTasks } from "@/stores/tasks";

/**
 * 백엔드 task-event 구독 + 부트스트랩.
 *
 * - 마운트 시 tasks_list 로 현재 큐 snapshot 받아 store init
 * - TaskEvent::Completed 시: store remove 직전 task.affected_locations 으로
 *   refresh() 콜백 호출 (App 의 refreshAffected)
 * - 종결 상태 (completed/cancelled/failed) 는 즉시 store 에서 remove —
 *   TasksBar 가 active 만 표시. history 보존은 후속 (MVP-7).
 */
export function useTaskEvents(refresh: (locations: Location[]) => void) {
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
        case "completed": {
          setStatus(id, { kind: "completed", journal_id: payload.change.journal_id });
          const task = useTasks.getState().tasks.get(id);
          if (task) refresh(task.affected_locations);
          remove(id);
          break;
        }
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
  }, [add, setStatus, setProgress, setError, remove, refresh]);
}
