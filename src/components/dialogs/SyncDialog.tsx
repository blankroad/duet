import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle, FilePlus2, Trash2, Loader2 } from "lucide-react";
import clsx from "clsx";
import { commands, type Location, type SyncPreview, type TrashUsage } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { formatSize } from "@/lib/format";

export interface SyncDialogProps {
  srcLabel: string;
  dstLabel: string;
  src: Location;
  dst: Location;
  onClose: () => void;
  /** prune=true 면 src 에 없는 dst 파일을 휴지통으로(삭제 전파). */
  onConfirm: (prune: boolean) => void;
}

/**
 * 단방향 미러 확인 — 방향 + dry-run(복사/삭제 목록 사전 표시) + prune 토글.
 * prune 은 기본 OFF. 켜면 대상 전용 파일을 휴지통으로(undo 가능). 켰을 때 CTA danger.
 */
export function SyncDialog({ srcLabel, dstLabel, src, dst, onClose, onConfirm }: SyncDialogProps) {
  const [prune, setPrune] = useState(false);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trash, setTrash] = useState<TrashUsage | null>(null);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const r = await commands.fsSyncPreview(src, dst);
      if (stale) return;
      if (r.status === "ok") setPreview(r.data);
      else setError(formatErr(r.error));
    })();
    return () => {
      stale = true;
    };
  }, [src, dst]);

  // 원격 휴지통 누적 — prune/백업이 쌓이는 곳(dst 우선). 로컬↔로컬이면 생략.
  useEffect(() => {
    const sshSource =
      dst.source.kind === "ssh" ? dst.source : src.source.kind === "ssh" ? src.source : null;
    if (!sshSource) return;
    let stale = false;
    void (async () => {
      const r = await commands.fsTrashUsage(sshSource);
      if (!stale && r.status === "ok" && r.data.available) setTrash(r.data);
    })();
    return () => {
      stale = true;
    };
  }, [src, dst]);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">Sync to other pane</Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted hover:bg-border" aria-label="Close">
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="text-base">
            <span className="font-mono">{srcLabel}</span>
            <span className="mx-2 text-fg-muted">→</span>
            <span className="font-mono">{dstLabel}</span>
          </div>

          {/* dry-run 요약 + 목록 */}
          <div className="mt-3 min-h-0 flex-1">
            {error ? (
              <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-meta text-danger">
                Preview failed: {error}
              </div>
            ) : preview == null ? (
              <div className="flex items-center gap-2 text-meta text-fg-muted">
                <Loader2 size={13} className="animate-spin" /> Computing changes…
              </div>
            ) : (
              <div className="space-y-2 text-meta">
                <Section
                  icon={<FilePlus2 size={12} className="text-accent" />}
                  label="Copy (new/changed)"
                  items={preview.copy}
                  tone="text-fg"
                />
                <Section
                  icon={<Trash2 size={12} className={prune ? "text-danger" : "text-fg-muted"} />}
                  label={prune ? "Delete (trash)" : "Target-only (not deleted)"}
                  items={preview.prune}
                  tone={prune ? "text-danger" : "text-fg-muted"}
                />
                {preview.truncated && (
                  <div className="text-amber-600">Too many items — only some are shown.</div>
                )}
              </div>
            )}
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-2 text-base">
            <input
              type="checkbox"
              checked={prune}
              onChange={(e) => setPrune(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Also delete files missing from source (mirror)
              <span className="block text-meta text-fg-muted">
                Sends files that exist only in the target{preview ? ` (${preview.prune.length})` : ""} to trash.
              </span>
            </span>
          </label>

          {trash && (
            <div className="mt-2 text-meta text-fg-muted">
              Remote trash (<span className="font-mono">~/.duet-trash</span>) accumulated:{" "}
              <b className={trash.bytes > 0 ? "text-fg" : ""}>{formatSize(trash.bytes)}</b>
              {trash.bytes > 0 && " — prune/overwrite backups pile up on this host."}
            </div>
          )}

          {prune && (
            <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-meta text-amber-600">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                Files only in the target folder move to trash. Undoable
                (macOS local: restore manually in Finder).
              </span>
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(prune)}
              className={clsx("rounded px-3 py-1 text-base text-white", prune ? "bg-danger" : "bg-accent")}
            >
              {prune ? "Sync + delete" : "Sync"}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            One-way mirror from the active pane to the other pane, with optional delete propagation.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Section({
  icon,
  label,
  items,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  items: string[];
  tone: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-fg-muted">
        {icon}
        <span>
          {label}: <b className="text-fg">{items.length}</b>
        </span>
      </div>
      {items.length > 0 && (
        <div
          className={clsx(
            "mt-1 max-h-24 overflow-auto rounded border border-border bg-subtle/40 px-2 py-1 font-mono",
            tone,
          )}
        >
          {items.slice(0, 200).map((rel) => (
            <div key={rel} className="truncate" title={rel}>
              {rel}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
