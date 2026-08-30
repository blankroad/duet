import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader } from "lucide-react";
import { formatSize } from "@/lib/format";
import { useTasks } from "@/stores/tasks";
import { commands } from "@/types/bindings";
import type { Location, ProgressInfo, TaskDto } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { RouteBlock } from "./RouteBlock";

/**
 * 복사/이동/동기화의 경로. commands 레이어가 enqueue 시 `affected_locations` 를
 * [목적지, 원본] 순으로 채운다 (fs_ops.rs — "refresh 할 location: dst + src").
 * 그 외 kind(삭제·압축 등)는 목적지 개념이 없어 표시하지 않는다.
 */
function routeOf(
  task: TaskDto | undefined,
): { src: Location | null; dst: Location } | null {
  if (!task) return null;
  if (task.kind !== "copy" && task.kind !== "move" && task.kind !== "sync")
    return null;
  const dst = task.affected_locations[0];
  if (!dst) return null;
  return { src: task.affected_locations[1] ?? null, dst };
}

/**
 * 진행률 모달 — DESIGN.md "진행률 다이얼로그": [Background] [Cancel].
 * Esc/X 는 백그라운드(작업은 계속) — 취소는 버튼으로만.
 */
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
  const route = routeOf(task);

  useEffect(() => {
    if (task === undefined) onBackground();
  }, [task, onBackground]);

  return (
    <DialogShell
      title={title}
      icon={Loader}
      iconTone="accent"
      iconClassName="animate-spin"
      onClose={onBackground}
      dismissOnOutsideClick={false}
      footer={
        <>
          <DialogButton hint="esc" onClick={onBackground}>
            {t("common.background")}
          </DialogButton>
          <DialogButton
            dangerText
            // 취소 요청만 보내고 모달은 유지 — task 가 실제로 사라지면
            // (cancelled 이벤트 → store 제거) 위 useEffect 가 닫는다.
            onClick={() => void commands.taskCancel(taskId)}
          >
            {t("common.cancel")}
          </DialogButton>
        </>
      }
    >
      {progress ? (
        <ProgressBody p={progress} />
      ) : (
        <div className="flex items-center gap-2 text-base text-fg-muted">
          <Loader size={14} className="animate-spin" />
          <span>{t("common.working")}</span>
        </div>
      )}
      {route && <RouteBlock src={route.src} dst={route.dst} />}
      {progress && <ProgressStats p={progress} />}
    </DialogShell>
  );
}

/** 현재 파일 = 이 모달의 주인공. 크기/굵기로 경로·수치보다 위계를 높인다. */
function ProgressBody({ p }: { p: ProgressInfo }) {
  if (!p.current_file && p.files_total === 0) return null;
  return (
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
  );
}

function ProgressStats({ p }: { p: ProgressInfo }) {
  const { t } = useTranslation();
  // percent==null = 총량 미상(폴더 등) → 게이지를 0% 고정 대신 "진행 중" 애니메이션.
  const indeterminate = p.percent == null;
  const pct = p.percent ?? 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="h-2 w-full overflow-hidden rounded bg-subtle">
        {indeterminate ? (
          <div className="h-full w-1/3 animate-indeterminate rounded bg-accent" />
        ) : (
          <div
            className="h-full rounded bg-accent transition-all"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </div>
      {/* 수치는 tabular-nums — 빠르게 갱신될 때 자릿수 흔들림으로 읽기 어려워짐 방지. */}
      <div className="flex justify-between gap-3 text-meta tabular-nums text-fg-muted">
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
