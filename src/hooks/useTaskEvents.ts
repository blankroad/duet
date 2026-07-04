import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { events, commands } from "@/types/bindings";
import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { takeElevatable, elevatableDestKind } from "@/lib/elevatePending";
import { takeExtract } from "@/lib/extractPending";

const isWindows = platform() === "windows";
/** DuetError Display 가 로컬 access-denied 를 나타내는지 (승격 재시도 후보). */
const PERM_DENIED = /permission denied|os error 5|access is denied/i;

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
          takeElevatable(id); // 성공 → 승격/암호 재시도 후보 정리
          takeExtract(id);
          remove(id);
          break;
        case "cancelled":
          setStatus(id, { kind: "cancelled" });
          takeElevatable(id);
          takeExtract(id);
          remove(id);
          break;
        case "failed": {
          const msg = payload.change.message;
          setError(id, msg);
          setStatus(id, { kind: "failed", message: msg });
          // 암호 zip 해제가 NeedPassword 로 실패 → 실패 토스트 대신 암호 다이얼로그를
          // 열어 재시도 (틀린 암호 재입력 포함).
          const extract = takeExtract(id);
          if (extract && payload.change.error.kind === "NeedPassword") {
            useUIDialogs.getState().open({
              kind: "extract-password",
              plan: extract.plan,
              wrong: extract.attempted,
            });
            remove(id);
            break;
          }
          // 보호 폴더 복사가 권한으로 실패했으면(Windows) 관리자 승격 재시도 다이얼로그.
          // 그 외엔 조용한 실패 방지용 토스트.
          const retry = takeElevatable(id);
          if (retry && PERM_DENIED.test(msg)) {
            const dialogs = useUIDialogs.getState();
            if (elevatableDestKind(retry) === "ssh") {
              // 원격 보호 경로 → sudo 재시도.
              dialogs.open({ kind: "sudo-op", pending: retry });
            } else if (isWindows) {
              // 로컬 Windows 보호 경로 → UAC 승격.
              dialogs.open({ kind: "elevate-op", pending: retry });
            } else {
              useToast.getState().show(`Operation failed — ${msg}`, "error");
            }
          } else {
            useToast.getState().show(`Operation failed — ${msg}`, "error");
          }
          remove(id);
          break;
        }
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [add, setStatus, setProgress, setError, remove]);
}
