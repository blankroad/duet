import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, X, ChevronDown, ChevronUp, Clock } from "lucide-react";
import { useTaskCancel } from "@/hooks/useTaskCancel";
import type { TaskDto } from "@/types/bindings";
import { useTasks, selectActive } from "@/stores/tasks";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { formatSize } from "@/lib/format";

/**
 * StatusBar 위 진행률 바.
 *
 * - active 0: hidden
 * - active 1+: 대표 작업(실행 중 우선) 한 줄 — 진행 막대·퍼센트·취소가 늘 보인다.
 *   2개 이상이면 오른쪽에 "작업 N개 · 대기 M ▾" 펼침 버튼으로 나머지를 연다.
 *
 * 예전엔 작업이 2개가 되는 순간 접힌 요약에서 막대와 취소가 사라져, 보고 있던 긴
 * 작업의 상태가 한 단계 아래로 숨었다. 대기(queued)는 시계 아이콘·"대기 중" 으로
 * 실행 중(스피너)과 구분한다. 작업 이름을 누르면 진행 상세(ETA·경로) 창을 다시 연다.
 */
export function TasksBar() {
  const { t } = useTranslation();
  const tasks = useTasks((s) => s.tasks);
  const [expanded, setExpanded] = useState(false);
  const active = selectActive(tasks);

  if (active.length === 0) return null;

  const lead = active.find((x) => x.status.kind === "running") ?? active[0]!;
  const others = active.filter((x) => x.id !== lead.id);
  const queued = active.filter((x) => x.status.kind === "queued").length;
  const open = expanded && others.length > 0;

  return (
    <div className="border-t border-border bg-subtle">
      <div className="flex h-7 items-center gap-2 px-3 text-meta">
        <TaskRow task={lead} />
        {others.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={open}
            className="flex min-h-6 shrink-0 items-center gap-1 rounded px-2 py-0.5 hover:bg-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {t("tasks.count", { count: active.length })}
            {queued > 0 && (
              <span className="text-fg-muted">
                {t("tasks.queuedCount", { count: queued })}
              </span>
            )}
            {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-[30vh] overflow-y-auto border-t border-border px-3 py-1">
          {others.map((task) => (
            <div key={task.id} className="flex py-0.5 text-meta">
              <TaskRow task={task} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 얇은 진행 막대 + 퍼센트. 총량을 모르면(percent null) 0% 고정 대신 왕복 애니메이션 —
 * 진행 모달과 같은 표현. 예전엔 전송량이 늘어도 빈 막대라 멈춘 것처럼 보였다.
 */
function ProgressMeter({ pct }: { pct: number | null }) {
  const { t } = useTranslation();
  const clamped = pct == null ? null : Math.min(100, Math.max(0, pct));
  return (
    <>
      <div
        role="progressbar"
        aria-label={t("tasks.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(clamped != null ? { "aria-valuenow": Math.round(clamped) } : {})}
        className="h-1 w-12 shrink-0 overflow-hidden rounded bg-border sm:w-24"
      >
        {clamped == null ? (
          <div className="h-full w-1/3 animate-indeterminate rounded bg-accent" />
        ) : (
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
      {clamped != null && (
        <span className="w-8 shrink-0 text-right tabular-nums text-fg-muted">
          {Math.round(clamped)}%
        </span>
      )}
    </>
  );
}

/**
 * 작업 표시 라벨 — 현재 파일명 우선, 없으면 kind 로 만든 현지화 라벨.
 *
 * backend 의 `task.title` 은 "Copying foo.zip → /very/long/dst" 형태라 좁은
 * 바에서 truncate 되면 정작 파일명이 잘려 나간다(+ 하드코딩 영어). 전체 문자열은
 * tooltip 으로만 남긴다.
 */
function taskLabel(task: TaskDto, t: (k: string) => string): string {
  return task.progress?.current_file || t(`tasks.kind.${task.kind}`);
}

function TaskRow({ task }: { task: TaskDto }) {
  const { t } = useTranslation();
  const { cancelling, cancel } = useTaskCancel(task.id);
  const queued = task.status.kind === "queued";
  const label = queued
    ? `${t("tasks.queued")} · ${t(`tasks.kind.${task.kind}`)}`
    : taskLabel(task, t);
  const openDetails = () =>
    useUIDialogs
      .getState()
      .open({ kind: "progress", title: task.title, taskId: task.id });
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {queued ? (
        <Clock size={11} className="shrink-0 text-fg-muted" />
      ) : (
        <Loader size={11} className="shrink-0 animate-spin text-fg-muted" />
      )}
      {/* 누르면 진행 상세 창 — tooltip 은 backend 전체 요약(출발→목적지). */}
      <button
        type="button"
        onClick={openDetails}
        title={`${task.title} — ${t("tasks.openDetails")}`}
        className={
          (queued ? "text-fg-muted" : "text-fg") +
          " min-w-0 flex-1 truncate rounded text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        }
      >
        {cancelling ? t("dialog.progress.stopping") : label}
      </button>
      {task.progress && !queued && (
        <>
          <ProgressMeter pct={task.progress.percent} />
          <span className="min-w-0 max-w-[40%] truncate text-fg-muted">
            {task.kind === "delete"
              ? `${task.progress.files_done} / ${task.progress.files_total}`
              : formatSize(task.progress.bytes_done)}
            {task.kind !== "delete" && task.progress.bytes_total
              ? ` / ${formatSize(task.progress.bytes_total)}`
              : ""}
            {task.progress.speed_bps
              ? ` · ${formatSize(task.progress.speed_bps)}/s`
              : ""}
          </span>
        </>
      )}
      <button
        type="button"
        disabled={cancelling}
        onClick={() => void cancel()}
        className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={t("sidebar.cancelTask")}
        title={t("sidebar.cancelTask")}
      >
        <X size={11} />
      </button>
    </div>
  );
}
