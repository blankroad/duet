import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle } from "lucide-react";
import clsx from "clsx";

export interface SyncDialogProps {
  srcLabel: string;
  dstLabel: string;
  onClose: () => void;
  /** prune=true 면 src 에 없는 dst 파일을 휴지통으로(삭제 전파). */
  onConfirm: (prune: boolean) => void;
}

/**
 * 단방향 미러 확인 — 방향 표시 + prune(삭제 전파) 토글.
 * prune 은 기본 OFF. 켜면 src 에 없는 dst 파일을 휴지통으로 보냄(undo 가능,
 * macOS 로컬은 Finder 수동 복원). 켰을 때 CTA 가 danger 색 + 경고.
 */
export function SyncDialog({ srcLabel, dstLabel, onClose, onConfirm }: SyncDialogProps) {
  const [prune, setPrune] = useState(false);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
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
          <p className="mt-1 text-meta text-fg-muted">
            한쪽 방향 미러 — 새/변경 파일을 복사하고 미변경은 건너뜁니다. 덮어쓰는 파일은
            백업되어 Undo 로 복원됩니다.
          </p>

          <label className="mt-3 flex cursor-pointer items-start gap-2 text-base">
            <input
              type="checkbox"
              checked={prune}
              onChange={(e) => setPrune(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              source 에 없는 파일도 삭제 (mirror)
              <span className="block text-meta text-fg-muted">
                대상에만 있는 파일을 휴지통으로 보냅니다.
              </span>
            </span>
          </label>

          {prune && (
            <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-meta text-amber-600">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                대상 폴더에만 있는 파일이 휴지통으로 이동합니다. Undo 로 되돌릴 수 있으나
                (macOS 로컬은 Finder 에서 수동 복원).
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
              className={clsx(
                "rounded px-3 py-1 text-base text-white",
                prune ? "bg-danger" : "bg-accent",
              )}
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
