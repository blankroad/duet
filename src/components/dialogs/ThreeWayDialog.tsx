import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, GitMerge, AlertTriangle } from "lucide-react";
import clsx from "clsx";
import type { ThreeWayPlan, ThreeWayStatus } from "@/types/bindings";

const LABEL: Record<ThreeWayStatus, string> = {
  unchanged: "",
  left_changed: "← 변경",
  right_changed: "변경 →",
  both_changed: "양쪽 변경",
  left_added: "← 추가",
  right_added: "추가 →",
  add_conflict: "추가 충돌",
  left_deleted: "← 삭제",
  right_deleted: "삭제 →",
  delete_conflict: "삭제 충돌",
};

const TONE: Record<ThreeWayStatus, string> = {
  unchanged: "text-fg-muted",
  left_changed: "text-accent",
  right_changed: "text-accent",
  both_changed: "text-danger",
  left_added: "text-accent",
  right_added: "text-accent",
  add_conflict: "text-danger",
  left_deleted: "text-amber-500",
  right_deleted: "text-amber-500",
  delete_conflict: "text-danger",
};

const CONFLICT_SET = new Set<ThreeWayStatus>(["both_changed", "add_conflict", "delete_conflict"]);

/**
 * 3-way 비교 결과 — base 대비 left/right 변화를 '추가 vs 삭제'까지 구별해 표시.
 * 읽기 전용(자동해결/충돌 적용은 후속). 충돌만 보기 토글.
 */
export function ThreeWayDialog({ plan, onClose }: { plan: ThreeWayPlan; onClose: () => void }) {
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const base = (loc: { path: string }) => String(loc.path).split("/").filter(Boolean).pop() ?? "/";
  const rows = plan.entries.filter((e) => !onlyConflicts || CONFLICT_SET.has(e.status));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-2 flex items-start justify-between">
            <Dialog.Title className="flex items-center gap-1.5 text-title font-medium">
              <GitMerge size={15} /> 3-way 비교
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted hover:bg-border" aria-label="Close">
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="mb-2 flex flex-wrap gap-x-3 text-meta text-fg-muted">
            <span>
              base <span className="font-mono text-fg" title={String(plan.base.path)}>{base(plan.base)}</span>
            </span>
            <span>
              left <span className="font-mono text-fg" title={String(plan.left.path)}>{base(plan.left)}</span>
            </span>
            <span>
              right <span className="font-mono text-fg" title={String(plan.right.path)}>{base(plan.right)}</span>
            </span>
          </div>

          <div className="mb-2 flex items-center gap-3 text-meta">
            <span className="text-fg-muted">
              자동 해결 <b className="text-fg">{plan.auto}</b>
            </span>
            <span className={clsx(plan.conflicts > 0 ? "text-danger" : "text-fg-muted")}>
              충돌 <b>{plan.conflicts}</b>
            </span>
            {plan.conflicts > 0 && (
              <label className="ml-auto flex items-center gap-1 text-fg-muted">
                <input
                  type="checkbox"
                  checked={onlyConflicts}
                  onChange={(e) => setOnlyConflicts(e.target.checked)}
                />
                충돌만
              </label>
            )}
          </div>

          {plan.truncated && (
            <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-meta text-amber-600">
              항목이 많아 일부만 표시했습니다 (상한 도달).
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
            {rows.length === 0 ? (
              <div className="px-2 py-3 text-center text-meta text-fg-muted">
                {plan.entries.length === 0
                  ? "차이 없음 — base 기준으로 left/right 가 동일합니다."
                  : "표시할 항목 없음."}
              </div>
            ) : (
              <table className="w-full text-meta">
                <tbody>
                  {rows.map((e, i) => (
                    <tr key={`${e.rel}:${i}`} className="even:bg-subtle/40">
                      <td className={clsx("w-28 px-2 py-0.5 font-medium", TONE[e.status])}>
                        <span className="flex items-center gap-1">
                          {CONFLICT_SET.has(e.status) && <AlertTriangle size={10} />}
                          {LABEL[e.status]}
                        </span>
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
              base 대비 변화로 '추가 vs 삭제'를 구별 — 충돌만 사용자 판단 필요. (적용은 후속)
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Close
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Three-way comparison of left and right against a common base directory.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
