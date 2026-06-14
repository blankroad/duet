import * as Dialog from "@radix-ui/react-dialog";
import { X, FolderGit2 } from "lucide-react";
import clsx from "clsx";
import type { ComparePlan, CompareStatus } from "@/types/bindings";

export interface CompareDialogProps {
  plan: ComparePlan;
  onClose: () => void;
  /** 양방향 머지 실행 — 한쪽에만 있는 파일을 반대편으로 복사(충돌 미변경). */
  onMerge: () => void;
}

const LABEL: Record<CompareStatus, string> = {
  left_only: "← only",
  right_only: "only →",
  newer_left: "← newer",
  newer_right: "newer →",
  differ: "differ",
  same: "same",
};

const TONE: Record<CompareStatus, string> = {
  left_only: "text-accent",
  right_only: "text-accent",
  newer_left: "text-amber-500",
  newer_right: "text-amber-500",
  differ: "text-danger",
  same: "text-fg-muted",
};

/**
 * 두 패널 폴더 비교 결과 — 차이만 목록(좌측만/우측만/다름), 같은 항목은 숨김.
 * 읽기 전용. (양방향 머지 액션은 별도.)
 */
export function CompareDialog({ plan, onClose, onMerge }: CompareDialogProps) {
  const diffs = plan.entries.filter((e) => e.status !== "same");
  const mergeable = plan.left_only + plan.right_only;
  const base = (loc: { path: string }) => String(loc.path).split("/").filter(Boolean).pop() ?? "/";

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-2 flex items-start justify-between">
            <Dialog.Title className="flex items-center gap-1.5 text-title font-medium">
              <FolderGit2 size={15} /> Compare folders
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted hover:bg-border" aria-label="Close">
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2 text-meta">
            <div className="truncate">
              <span className="text-fg-muted">left </span>
              <span className="font-mono" title={String(plan.left.path)}>{base(plan.left)}</span>
            </div>
            <div className="truncate text-right">
              <span className="font-mono" title={String(plan.right.path)}>{base(plan.right)}</span>
              <span className="text-fg-muted"> right</span>
            </div>
          </div>

          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-meta text-fg-muted">
            <span>← only: <b className="text-fg">{plan.left_only}</b></span>
            <span>only →: <b className="text-fg">{plan.right_only}</b></span>
            <span>differ: <b className="text-fg">{plan.differ}</b></span>
            <span>same: <b className="text-fg">{plan.same}</b></span>
          </div>

          {plan.truncated && (
            <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-meta text-amber-600">
              비교 항목이 많아 일부만 표시했습니다 (상한 도달).
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
            {diffs.length === 0 ? (
              <div className="px-2 py-3 text-center text-meta text-fg-muted">
                차이 없음 — 두 폴더가 동일합니다.
              </div>
            ) : (
              <table className="w-full text-meta">
                <tbody>
                  {diffs.map((e, i) => (
                    <tr key={`${e.rel}:${i}`} className="even:bg-subtle/40">
                      <td className={clsx("w-20 px-2 py-0.5 font-medium", TONE[e.status])}>
                        {LABEL[e.status]}
                      </td>
                      <td className="truncate px-2 py-0.5 font-mono" title={e.rel}>
                        {e.kind === "dir" ? `${e.rel}/` : e.rel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-meta text-fg-muted">
              {mergeable > 0
                ? `머지: 한쪽에만 있는 ${mergeable}개를 반대편으로 복사 (차이는 미변경)`
                : ""}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
              >
                Close
              </button>
              <button
                type="button"
                onClick={onMerge}
                disabled={mergeable === 0}
                className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
                title="한쪽에만 있는 파일을 양방향으로 복사 (덮어쓰기/삭제 없음, undo 가능)"
              >
                Merge ↔
              </button>
            </div>
          </div>
          <Dialog.Description className="sr-only">
            Recursive comparison of the two pane directories.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
