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
        적용: 생성 <b className="text-fg">{create}</b> · 덮어쓰기{" "}
        <b className="text-fg">{overwrite}</b>
        {overwrite > 0 && " (백업 후, undo 가능)"}
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
              ? "비교가 잘려 머지할 수 없습니다 — 범위를 좁히세요"
              : "한쪽에만 있는 파일을 양방향으로 복사 (덮어쓰기/삭제 없음, undo 가능)"
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
              ? "비교가 잘려 적용할 수 없습니다 — 범위를 좁히세요"
              : "고른 방향대로 적용 (덮어쓰기는 .bak 백업, undo 가능)"
          }
        >
          Apply ({applyCount})
        </button>
      </div>
    </div>
  );
}
