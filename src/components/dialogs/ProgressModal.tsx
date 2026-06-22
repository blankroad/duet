import { useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader, X } from "lucide-react";
import { formatSize } from "@/lib/format";
import { useTasks } from "@/stores/tasks";
import type { ProgressInfo } from "@/types/bindings";

export function ProgressModal({
  title,
  taskId,
  onBackground,
}: {
  title: string;
  taskId: string;
  onBackground: () => void;
}) {
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
              aria-label="Background"
              title="Run in background"
            >
              <X size={14} />
            </button>
          </div>

          {progress ? <ProgressBody p={progress} /> : <SpinnerBody />}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onBackground}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Background
            </button>
          </div>

          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SpinnerBody() {
  return (
    <div className="mt-3 flex items-center gap-2 text-base text-fg-muted">
      <Loader size={14} className="animate-spin" />
      <span>Working…</span>
    </div>
  );
}

function ProgressBody({ p }: { p: ProgressInfo }) {
  const pct = p.percent ?? 0;
  return (
    <div className="mt-3 space-y-2">
      {/* 현재 파일 + 항목 카운트 (탐색기/TC 식 "지금 뭘 하는지"). */}
      {(p.current_file || p.files_total > 0) && (
        <div className="flex items-baseline justify-between gap-2 text-base">
          <span className="min-w-0 flex-1 truncate font-mono text-fg">
            {p.current_file ?? "…"}
          </span>
          {p.files_total > 0 && (
            <span className="shrink-0 text-meta text-fg-muted">
              {Math.min(p.files_done + 1, p.files_total)} / {p.files_total}
            </span>
          )}
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded bg-subtle">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="flex justify-between text-meta text-fg-muted">
        <span>
          {formatSize(p.bytes_done)}
          {p.bytes_total ? ` / ${formatSize(p.bytes_total)}` : ""}
          {p.percent != null ? ` · ${p.percent}%` : ""}
        </span>
        <span>
          {p.speed_bps ? `${formatSize(p.speed_bps)}/s` : ""}
          {p.eta_sec != null ? ` · ETA ${formatEta(p.eta_sec)}` : ""}
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
