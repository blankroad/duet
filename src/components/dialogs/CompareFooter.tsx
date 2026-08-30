import { DialogButton } from "./DialogButton";

/**
 * 비교창 푸터 — 적용 요약(생성/덮어쓰기)은 `CompareFooterSummary`(DialogShell 의
 * footerLeft), 액션은 `CompareFooterButtons`(footer). truncated 면 Merge/Apply
 * 비활성(부분 작업 방지).
 */
export function CompareFooterSummary({
  create,
  overwrite,
}: {
  create: number;
  overwrite: number;
}) {
  return (
    <span>
      Apply: create <b className="text-fg">{create}</b> · overwrite{" "}
      <b className="text-fg">{overwrite}</b>
      {overwrite > 0 && " (after backup, undoable)"}
    </span>
  );
}

export function CompareFooterButtons({
  applyCount,
  mergeable,
  truncated,
  onClose,
  onMerge,
  onApply,
}: {
  applyCount: number;
  mergeable: number;
  truncated: boolean;
  onClose: () => void;
  onMerge: () => void;
  onApply: () => void;
}) {
  return (
    <>
      <DialogButton hint="esc" onClick={onClose}>
        Close
      </DialogButton>
      <span
        title={
          truncated
            ? "Comparison truncated — can't merge. Narrow the scope."
            : "Copy one-side-only files both ways (no overwrite/delete, undoable)"
        }
      >
        <DialogButton disabled={mergeable === 0 || truncated} onClick={onMerge}>
          Merge ↔
        </DialogButton>
      </span>
      <span
        title={
          truncated
            ? "Comparison truncated — can't apply. Narrow the scope."
            : "Apply chosen directions (overwrites backed up to .bak, undoable)"
        }
      >
        <DialogButton
          tone="primary"
          disabled={applyCount === 0 || truncated}
          onClick={onApply}
        >
          Apply ({applyCount})
        </DialogButton>
      </span>
    </>
  );
}
