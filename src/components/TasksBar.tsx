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
          {active[0]!.title}
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

function TaskRow({ task }: { task: TaskDto }) {
  const { t } = useTranslation();
  const pct = task.progress?.percent ?? 0;
  // 현재 파일명 우선(사이드바 TasksSection 통합분) — 없으면 task title.
  const label = task.progress?.current_file || task.title;
  return (
    <div className="flex flex-1 items-center gap-2">
      <Loader size={11} className="shrink-0 animate-spin text-fg-muted" />
      <span className="truncate text-fg" title={label}>
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
