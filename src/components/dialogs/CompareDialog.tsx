import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, FolderGit2, Search } from "lucide-react";
import clsx from "clsx";
import type { ComparePlan, CompareStatus } from "@/types/bindings";
import {
  ALL_STATUSES,
  DIFF_STATUSES,
  LABEL,
  TONE,
  ICON,
  strategyBadge,
  sizeText,
  mtimeText,
} from "./compareView";

export interface CompareDialogProps {
  plan: ComparePlan;
  onClose: () => void;
  /** 양방향 머지 실행 — 한쪽에만 있는 파일을 반대편으로 복사(충돌 미변경). */
  onMerge: () => void;
}

/**
 * 두 패널 폴더 비교 결과 — 상태 필터칩 + 경로검색 + 양쪽 메타(크기·시각) 컬럼.
 * 키보드(↑↓)로 행 이동. 읽기 전용(양방향 머지 액션은 별도, truncated 면 비활성).
 */
export function CompareDialog({ plan, onClose, onMerge }: CompareDialogProps) {
  // 기본 필터: 차이만(same 숨김). unreadable 은 경고라 기본 표시.
  const [active, setActive] = useState<Set<CompareStatus>>(
    () => new Set<CompareStatus>([...DIFF_STATUSES, "unreadable"]),
  );
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const selectedRowRef = useRef<HTMLTableRowElement>(null);

  const counts = useMemo(() => {
    const c: Record<CompareStatus, number> = {
      left_only: 0,
      right_only: 0,
      newer_left: 0,
      newer_right: 0,
      differ: 0,
      same: 0,
      unreadable: 0,
    };
    for (const e of plan.entries) c[e.status] += 1;
    return c;
  }, [plan.entries]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plan.entries.filter(
      (e) => active.has(e.status) && (q === "" || e.rel.toLowerCase().includes(q)),
    );
  }, [plan.entries, active, query]);

  const selClamped = Math.min(sel, Math.max(0, rows.length - 1));
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [selClamped, rows.length]);

  const mergeable = plan.left_only + plan.right_only;
  const badge = strategyBadge(plan.strategy);
  const base = (loc: { path: string }) => String(loc.path).split("/").filter(Boolean).pop() ?? "/";

  const toggle = (s: CompareStatus) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-2 flex items-start justify-between">
            <Dialog.Title className="flex items-center gap-1.5 text-title font-medium">
              <FolderGit2 size={15} /> Compare folders
            </Dialog.Title>
            <div className="flex items-center gap-2">
              <span
                className={clsx("rounded border px-1.5 py-0.5 text-meta", badge.tone)}
                title={badge.title}
              >
                {badge.label}
              </span>
              <Dialog.Close
                className="rounded p-1 text-fg-muted hover:bg-border"
                aria-label="Close"
              >
                <X size={14} />
              </Dialog.Close>
            </div>
          </div>

          <div className="mb-2 grid grid-cols-2 gap-2 text-meta">
            <div className="truncate">
              <span className="text-fg-muted">left </span>
              <span className="font-mono" title={String(plan.left.path)}>
                {base(plan.left)}
              </span>
            </div>
            <div className="truncate text-right">
              <span className="font-mono" title={String(plan.right.path)}>
                {base(plan.right)}
              </span>
              <span className="text-fg-muted"> right</span>
            </div>
          </div>

          {/* 필터칩(상태별 카운트, 클릭 토글) + 경로 검색 */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {ALL_STATUSES.filter((s) => counts[s] > 0).map((s) => {
              const on = active.has(s);
              const Icon = ICON[s];
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggle(s)}
                  aria-pressed={on}
                  className={clsx(
                    "flex items-center gap-1 rounded border px-1.5 py-0.5 text-meta",
                    on ? "border-border bg-subtle" : "border-transparent text-fg-muted opacity-60",
                  )}
                  title={`${LABEL[s]} 토글`}
                >
                  <Icon size={11} className={TONE[s]} />
                  <span>{LABEL[s]}</span>
                  <b className="text-fg">{counts[s]}</b>
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-1 rounded border border-border bg-subtle px-1.5">
              <Search size={11} className="text-fg-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="경로 검색"
                className="w-32 bg-transparent py-0.5 text-meta focus:outline-none"
              />
            </div>
          </div>

          {counts.unreadable > 0 && (
            <div className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-meta text-danger">
              {counts.unreadable}개 디렉토리를 읽지 못했습니다 — 머지/동기화에서 제외됩니다.
            </div>
          )}
          {plan.truncated && (
            <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-meta text-amber-600">
              비교 항목이 많아 일부만 표시했습니다 (상한 도달) — 머지는 비활성화됩니다.
            </div>
          )}

          <div
            className="min-h-0 flex-1 overflow-y-auto rounded border border-border focus:outline-none focus:ring-1 focus:ring-accent"
            tabIndex={0}
            role="listbox"
            aria-label="비교 결과"
            onKeyDown={onKeyDown}
          >
            {rows.length === 0 ? (
              <div className="px-2 py-3 text-center text-meta text-fg-muted">
                {plan.entries.length === 0
                  ? "차이 없음 — 두 폴더가 동일합니다."
                  : "표시할 항목 없음 (필터/검색 조건)."}
              </div>
            ) : (
              <table className="w-full text-meta">
                <tbody>
                  {rows.map((e, i) => {
                    const RowIcon = ICON[e.status];
                    return (
                    <tr
                      key={`${e.rel}:${i}`}
                      ref={i === selClamped ? selectedRowRef : undefined}
                      role="option"
                      aria-selected={i === selClamped}
                      onClick={() => setSel(i)}
                      className={clsx(
                        "cursor-default",
                        i === selClamped ? "bg-accent/15" : "even:bg-subtle/40",
                      )}
                    >
                      <td className={clsx("w-24 px-2 py-0.5 font-medium", TONE[e.status])}>
                        <span className="flex items-center gap-1">
                          <RowIcon size={11} />
                          {LABEL[e.status]}
                        </span>
                      </td>
                      <td className="truncate px-2 py-0.5 font-mono" title={e.rel}>
                        {e.kind === "dir" ? `${e.rel}/` : e.rel}
                      </td>
                      <td className="w-28 whitespace-nowrap px-2 py-0.5 text-right text-fg-muted">
                        {sizeText(e)}
                      </td>
                      <td className="w-20 whitespace-nowrap px-2 py-0.5 text-right text-fg-muted">
                        {mtimeText(e)}
                      </td>
                    </tr>
                    );
                  })}
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
                disabled={mergeable === 0 || plan.truncated}
                className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
                title={
                  plan.truncated
                    ? "비교가 잘려 머지할 수 없습니다 — 범위를 좁히세요"
                    : "한쪽에만 있는 파일을 양방향으로 복사 (덮어쓰기/삭제 없음, undo 가능)"
                }
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
