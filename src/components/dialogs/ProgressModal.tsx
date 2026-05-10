import * as Dialog from "@radix-ui/react-dialog";
import { Loader } from "lucide-react";
import { formatSize } from "@/lib/format";
import type { ProgressInfo } from "@/stores/ui-dialogs";

export function ProgressModal({
  title,
  progress,
}: {
  title: string;
  /** undefined = spinner; ProgressInfo = bar 표시. exactOptionalPropertyTypes
   *  하에서 dialog.progress (optional 필드) 를 그대로 넘기기 위해 explicit union. */
  progress: ProgressInfo | undefined;
}) {
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <Dialog.Title className="text-title font-medium">{title}</Dialog.Title>

          {progress ? <ProgressBody p={progress} /> : <SpinnerBody />}

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
      <div className="h-2 w-full overflow-hidden rounded bg-subtle">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="flex justify-between text-meta text-fg-muted">
        <span>
          {formatSize(p.bytesDone)}
          {p.bytesTotal ? ` / ${formatSize(p.bytesTotal)}` : ""}
        </span>
        <span>
          {p.speedBps ? `${formatSize(p.speedBps)}/s` : ""}
          {p.etaSec != null ? ` · ETA ${formatEta(p.etaSec)}` : ""}
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
