import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { Loader, X } from "lucide-react";
import { formatSize } from "@/lib/format";
import { shortenPath } from "@/lib/paths";
import { useTasks } from "@/stores/tasks";
import { commands } from "@/types/bindings";
import type { ProgressInfo, TaskDto } from "@/types/bindings";

/**
 * 복사/이동/동기화의 "받는 위치". commands 레이어가 enqueue 시
 * `affected_locations[0]` 에 목적지를 넣는다 (fs_ops.rs:245/791/1101).
 * 그 외 kind(삭제·압축 등)는 목적지 개념이 없어 표시하지 않는다.
 */
function destPath(task: TaskDto | undefined): string | null {
  if (!task) return null;
  if (task.kind !== "copy" && task.kind !== "move" && task.kind !== "sync")
    return null;
  const dst = task.affected_locations[0];
  return dst ? String(dst.path) : null;
}

export function ProgressModal({
  title,
  taskId,
  onBackground,
}: {
  title: string;
  taskId: string;
  onBackground: () => void;
}) {
  const { t } = useTranslation();
  const task = useTasks((s) => s.tasks.get(taskId));
  const progress = task?.progress ?? null;

  useEffect(() => {
    if (task === undefined) onBackground();
  }, [task, onBackground]);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onBackground()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="text-title font-medium">
              {title}
            </Dialog.Title>
            <button
              type="button"
              onClick={onBackground}
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label={t("common.background")}
              title={t("common.runInBackground")}
            >
              <X size={14} />
            </button>
          </div>

          {progress ? (
            <ProgressBody p={progress} dst={destPath(task)} />
          ) : (
            <SpinnerBody dst={destPath(task)} />
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              // 취소 요청만 보내고 모달은 유지 — task 가 실제로 사라지면
              // (cancelled 이벤트 → store 제거) 위 useEffect 가 닫는다.
              onClick={() => void commands.taskCancel(taskId)}
              className="rounded border border-border px-3 py-1 text-base text-danger hover:bg-subtle"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              onClick={onBackground}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              {t("common.background")}
            </button>
          </div>

          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SpinnerBody({ dst }: { dst: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2 text-base text-fg-muted">
        <Loader size={14} className="animate-spin" />
        <span>{t("common.working")}</span>
      </div>
      <DestRow dst={dst} />
    </div>
  );
}

/**
 * 받는 위치 — 파일명과 **한 줄에 섞지 않는다**. 경로를 파일명 뒤에 이어붙이면
 * truncate 가 정작 파일명을 지운다. 경로는 가운데 생략(shortenPath)으로 말단을
 * 남기고, 전체 경로는 tooltip 으로.
 */
function DestRow({ dst }: { dst: string | null }) {
  const { t } = useTranslation();
  if (!dst) return null;
  return (
    <div className="flex items-baseline gap-2 text-meta text-fg-muted">
      <span className="shrink-0">{t("dialog.progress.dest")}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={dst}>
        {shortenPath(dst)}
      </span>
    </div>
  );
}

function ProgressBody({ p, dst }: { p: ProgressInfo; dst: string | null }) {
  const { t } = useTranslation();
  // percent==null = 총량 미상(폴더 등) → 게이지를 0% 고정 대신 "진행 중" 애니메이션.
  const indeterminate = p.percent == null;
  const pct = p.percent ?? 0;
  return (
    <div className="mt-3 space-y-2">
      {/* 현재 파일 = 이 모달의 주인공. 크기/굵기로 경로·수치보다 위계를 높인다. */}
      {(p.current_file || p.files_total > 0) && (
        <div className="flex items-baseline justify-between gap-3">
          <span
            className="min-w-0 flex-1 truncate font-mono text-base font-medium text-fg"
            title={p.current_file ?? undefined}
          >
            {p.current_file ?? "…"}
          </span>
          {p.files_total > 0 && (
            <span className="shrink-0 tabular-nums text-meta text-fg-muted">
              {Math.min(p.files_done + 1, p.files_total)} / {p.files_total}
            </span>
          )}
        </div>
      )}
      <DestRow dst={dst} />
      <div className="h-2 w-full overflow-hidden rounded bg-subtle">
        {indeterminate ? (
          <div className="h-full w-1/3 animate-indeterminate rounded bg-accent" />
        ) : (
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </div>
      {/* 수치는 tabular-nums — 빠르게 갱신될 때 자릿수 흔들림으로 읽기 어려워짐 방지. */}
      <div className="flex justify-between gap-3 tabular-nums text-meta text-fg-muted">
        <span className="truncate">
          {formatSize(p.bytes_done)}
          {p.bytes_total
            ? ` / ${formatSize(p.bytes_total)}`
            : ` ${t("dialog.progress.done")}`}
          {p.percent != null ? ` · ${p.percent}%` : ""}
        </span>
        <span className="shrink-0">
          {p.speed_bps ? `${formatSize(p.speed_bps)}/s` : ""}
          {p.eta_sec != null
            ? ` · ${t("dialog.progress.eta", { time: formatEta(p.eta_sec) })}`
            : ""}
        </span>
      </div>
    </div>
  );
}

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
