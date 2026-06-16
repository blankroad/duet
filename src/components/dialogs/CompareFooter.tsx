/**
 * 비교창 푸터 — 적용 요약(생성/덮어쓰기) + Close / Merge / Apply 액션.
 * truncated 면 Merge/Apply 비활성(부분 작업 방지).
 */
export function CompareFooter({
  create,
  overwrite,
  applyCount,
  mergeable,
  truncated,
  onClose,
  onMerge,
  onApply,
}: {
  create: number;
  overwrite: number;
  applyCount: number;
  mergeable: number;
  truncated: boolean;
  onClose: () => void;
  onMerge: () => void;
  onApply: () => void;
}) {
  return (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span className="text-meta text-fg-muted">
        Apply: create <b className="text-fg">{create}</b> · overwrite{" "}
        <b className="text-fg">{overwrite}</b>
        {overwrite > 0 && " (after backup, undoable)"}
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
          disabled={mergeable === 0 || truncated}
          className="rounded border border-border px-3 py-1 text-base hover:bg-subtle disabled:opacity-50"
          title={
            truncated
              ? "Comparison truncated — can't merge. Narrow the scope."
              : "Copy one-side-only files both ways (no overwrite/delete, undoable)"
          }
        >
          Merge ↔
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={applyCount === 0 || truncated}
          className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
          title={
            truncated
              ? "Comparison truncated — can't apply. Narrow the scope."
              : "Apply chosen directions (overwrites backed up to .bak, undoable)"
          }
        >
          Apply ({applyCount})
        </button>
      </div>
    </div>
  );
}
