import { useEffect } from "react";
import { platform } from "@tauri-apps/plugin-os";
import i18n from "@/i18n";
import { events, commands } from "@/types/bindings";
import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";
import { useUIDialogs, type DialogState } from "@/stores/ui-dialogs";
import { takeElevatable, elevatableDestKind } from "@/lib/elevatePending";
import { takeExtract } from "@/lib/extractPending";
import { explainError } from "@/lib/error";

const isWindows = platform() === "windows";

/**
 * 성공 토스트를 띄울 최소 소요 시간 — 이보다 빨리 끝난 작업은 결과가 이미 목록에
 * 보이므로 알리지 않는다 (DESIGN "성공 알림은 큰 작업만", 토스트 남용 금지).
 */
const SUCCESS_TOAST_MIN_MS = 2000;
/** taskId → 시작 시각. enqueued 에서 넣고 종결에서 뺀다. */
const startedAt = new Map<string, number>();
/** DuetError Display 가 로컬 access-denied 를 나타내는지 (승격 재시도 후보). */
const PERM_DENIED = /permission denied|os error 5|access is denied/i;

/** 백그라운드 작업의 질문 — 쓰던 창이 있으면 대기열에 넣고 알린다. */
function openOrQueue(d: DialogState): void {
  if (!useUIDialogs.getState().openWhenFree(d))
    useToast.getState().show(i18n.t("toast.dialogQueued"));
}

/**
 * 백엔드 task-event 구독 + 부트스트랩.
 *
 * - 구독을 건 뒤 tasks_list 스냅샷을 받아 store 에 **병합**(이벤트가 우선)
 * - 종결 상태 (completed/cancelled/failed) 는 즉시 store 에서 remove —
 *   TasksBar 가 active 만 표시. history 보존은 후속 (MVP-7).
 *
 * 작업 완료 후 패널 새로고침은 여기서 하지 않는다 — 백엔드 `TaskQueue` 가 완료 시
 * affected 디렉토리로 `fs-changed-event` 를 emit 하고, `useFsChangedEvents` 가
 * 외부 변경과 동일한 경로로 새로고침한다. (in-app / 외부 변경 새로고침 일원화.)
 */
export function useTaskEvents() {
  const mergeSnapshot = useTasks((s) => s.mergeSnapshot);
  const add = useTasks((s) => s.add);
  const setStatus = useTasks((s) => s.setStatus);
  const setProgress = useTasks((s) => s.setProgress);
  const setError = useTasks((s) => s.setError);
  const remove = useTasks((s) => s.remove);

  useEffect(() => {
    // 스냅샷과 이벤트의 순서 — 구독을 먼저 걸고 나서 스냅샷을 받는다(그 사이 이벤트를
    // 놓치지 않게). 스냅샷이 오기 전에 끝난 작업 id 는 기억했다가 병합 때 되살리지 않는다.
    let disposed = false;
    let snapshotPending = true;
    const terminated = new Set<string>();
    const markDone = (id: string) => {
      if (snapshotPending) terminated.add(id);
    };
    // 스냅샷 전에 온 시작·진행은 store 에 아직 그 작업이 없으면 버려진다(setStatus/
    // setProgress 는 없는 id 를 무시). 순서대로 모아 뒀다가 병합 뒤 다시 적용한다 —
    // 안 그러면 실제로 도는 작업이 스냅샷의 옛 "대기"·옛 진행률로 남았다.
    const replay: Array<() => void> = [];
    const unlistenP = events.taskEvent.listen(({ payload }) => {
      const id = payload.task_id;
      switch (payload.change.kind) {
        case "enqueued":
          add(payload.change.task);
          startedAt.set(id, Date.now());
          break;
        case "started":
          setStatus(id, { kind: "running" });
          if (snapshotPending)
            replay.push(() => setStatus(id, { kind: "running" }));
          break;
        case "progress": {
          const progress = payload.change.progress;
          setProgress(id, progress);
          if (snapshotPending) replay.push(() => setProgress(id, progress));
          break;
        }
        case "completed": {
          markDone(id);
          setStatus(id, {
            kind: "completed",
            journal_id: payload.change.journal_id,
          });
          takeElevatable(id); // 성공 → 승격/암호 재시도 후보 정리
          takeExtract(id);
          // 종결 즉시 목록에서 사라지므로 완료 확인 지점이 없던 문제 — 성공 토스트.
          // 단 눈 깜짝할 새 끝난 작업(파일 한두 개 복사)까지 알리면 토스트가 밀려
          // 정작 읽어야 할 에러를 밀어낸다. 오래 걸린 작업만 알린다.
          const began = startedAt.get(id);
          startedAt.delete(id);
          const slow =
            began === undefined || Date.now() - began >= SUCCESS_TOAST_MIN_MS;
          const title = useTasks.getState().tasks.get(id)?.title;
          if (slow)
            useToast
              .getState()
              .show(
                title
                  ? i18n.t("toast.taskDone", { title })
                  : i18n.t("toast.taskDoneGeneric"),
                "success",
              );
          remove(id);
          break;
        }
        case "cancelled": {
          markDone(id);
          setStatus(id, { kind: "cancelled" });
          startedAt.delete(id);
          takeElevatable(id);
          takeExtract(id);
          const title = useTasks.getState().tasks.get(id)?.title;
          useToast
            .getState()
            .show(
              title
                ? i18n.t("toast.taskCancelled", { title })
                : i18n.t("toast.taskCancelledGeneric"),
            );
          remove(id);
          break;
        }
        case "failed": {
          markDone(id);
          startedAt.delete(id);
          const msg = payload.change.message;
          setError(id, msg);
          setStatus(id, { kind: "failed", message: msg });
          // 암호 zip 해제가 NeedPassword 로 실패 → 실패 토스트 대신 암호 다이얼로그를
          // 열어 재시도 (틀린 암호 재입력 포함).
          const extract = takeExtract(id);
          if (extract && payload.change.error.kind === "NeedPassword") {
            openOrQueue({
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
          // "압축 풀기 실패 — <쉬운 원인>". 원문(작업 제목 + 백엔드 오류)은 알림 기록의 "자세히".
          const task = useTasks.getState().tasks.get(id);
          const explained = explainError(payload.change.error);
          const failed = () =>
            useToast.getState().show(
              task
                ? i18n.t("toast.taskFailedOp", {
                    op: i18n.t(`tasks.op.${task.kind}`),
                    msg: explained.text,
                  })
                : i18n.t("toast.taskFailed", { msg: explained.text }),
              "error",
              {
                detail: [task?.title, explained.detail || msg]
                  .filter(Boolean)
                  .join("\n"),
              },
            );
          if (retry && PERM_DENIED.test(msg)) {
            if (elevatableDestKind(retry) === "ssh") {
              // 원격 보호 경로 → sudo 재시도.
              openOrQueue({ kind: "sudo-op", pending: retry });
            } else if (isWindows) {
              // 로컬 Windows 보호 경로 → UAC 승격.
              openOrQueue({ kind: "elevate-op", pending: retry });
            } else {
              failed();
            }
          } else {
            failed();
          }
          remove(id);
          break;
        }
      }
    });
    void unlistenP
      .then(() => (disposed ? null : commands.tasksList()))
      .then((r) => {
        snapshotPending = false;
        if (disposed || !r || r.status !== "ok") return;
        mergeSnapshot(r.data, terminated);
        // 종결된 작업은 병합에서 빠졌으니 재적용해도 되살아나지 않는다(없는 id 무시).
        for (const apply of replay) apply();
        replay.length = 0;
        terminated.clear();
      });
    return () => {
      disposed = true;
      replay.length = 0;
      unlistenP.then((fn) => fn());
    };
  }, [add, setStatus, setProgress, setError, remove, mergeSnapshot]);
}
