import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader, X, ChevronDown, ChevronUp } from "lucide-react";
import { commands } from "@/types/bindings";
import type { TaskDto } from "@/types/bindings";
import { useTasks, selectActive } from "@/stores/tasks";
import { formatSize } from "@/lib/format";

/**
 * StatusBar 위 진행률 바.
 *
 * - active 0: hidden
 * - active 1: mini progress + Cancel
 * - active 2+: 첫 task summary + dropdown 토글
 */
export function TasksBar() {
  const { t } = useTranslation();
  const tasks = useTasks((s) => s.tasks);
  const [expanded, setExpanded] = useState(false);
  const active = selectActive(tasks);

  if (active.length === 0) return null;

  if (active.length === 1) {
    return (
      <div className="flex h-7 items-center gap-2 border-t border-border bg-subtle px-3 text-meta">
        <TaskRow task={active[0]!} />
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-subtle">
      <div className="flex h-7 items-center gap-2 px-3 text-meta">
        <Loader size={11} className="animate-spin text-fg-muted" />
        <span className="truncate text-fg" title={active[0]!.title}>
          {taskLabel(active[0]!, t)}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
        >
          {t("tasks.count", { count: active.length })}
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border px-3 py-1">
          {active.map((t) => (
            <div key={t.id} className="py-0.5">
              <TaskRow task={t} />
            </div>
          ))}
        </div>
      )}
    </div>
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
  const pct = task.progress?.percent ?? 0;
  const label = taskLabel(task, t);
  return (
    <div className="flex flex-1 items-center gap-2">
      <Loader size={11} className="shrink-0 animate-spin text-fg-muted" />
      {/* tooltip 은 backend 전체 요약(출발→목적지) — 라벨보다 정보가 많다. */}
      <span className="truncate text-fg" title={task.title}>
        {label}
      </span>
      {task.progress && (
        <>
          <div className="h-1 w-24 shrink-0 overflow-hidden rounded bg-border">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>
          <span className="shrink-0 text-fg-muted">
            {formatSize(task.progress.bytes_done)}
            {task.progress.bytes_total
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
        onClick={() => commands.taskCancel(task.id)}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted hover:bg-border hover:text-danger"
        aria-label={t("sidebar.cancelTask")}
        title={t("sidebar.cancelTask")}
      >
        <X size={11} />
      </button>
    </div>
  );
}
