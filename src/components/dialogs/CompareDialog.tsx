import { useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, FolderGit2, Search } from "lucide-react";
import clsx from "clsx";
import type { ApplyDecision, ApplyDirection, ComparePlan, CompareStatus } from "@/types/bindings";
import {
  ALL_STATUSES,
  DIFF_STATUSES,
  LABEL,
  TONE,
  ICON,
  strategyBadge,
  defaultDirection,
  isCreate,
} from "./compareView";
import { CompareList } from "./CompareList";

export interface CompareDialogProps {
  plan: ComparePlan;
  onClose: () => void;
  /** 양방향 머지 실행 — 한쪽에만 있는 파일을 반대편으로 복사(충돌 미변경). */
  onMerge: () => void;
  /** 행별 방향 적용 — 생성 + 덮어쓰기(백업, undo 가능). */
  onApply: (decisions: ApplyDecision[]) => void;
}

/**
 * 두 패널 폴더 비교 결과 — 상태 필터칩 + 경로검색 + 양쪽 메타 + 행별 방향 적용.
 * 리스트/키보드는 CompareList 가 담당. 머지/적용은 truncated 면 비활성.
 */
export function CompareDialog({ plan, onClose, onMerge, onApply }: CompareDialogProps) {
  // 기본 필터: 차이만(same 숨김). unreadable 은 경고라 기본 표시.
  const [active, setActive] = useState<Set<CompareStatus>>(
    () => new Set<CompareStatus>([...DIFF_STATUSES, "unreadable"]),
  );
  const [query, setQuery] = useState("");
  // 행별 적용 방향(rel → dir) — 상태별 기본값으로 초기화.
  const [decisions, setDecisions] = useState<Record<string, ApplyDirection>>(() => {
    const d: Record<string, ApplyDirection> = {};
    for (const e of plan.entries) d[e.rel] = defaultDirection(e.status);
    return d;
  });
  const listRef = useRef<HTMLDivElement>(null);

  const dirOf = (rel: string, status: CompareStatus): ApplyDirection =>
    decisions[rel] ?? defaultDirection(status);
  const setDir = (rel: string, dir: ApplyDirection) =>
    setDecisions((prev) => ({ ...prev, [rel]: dir }));

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

  // 적용 dry-run 집계 + payload (skip 제외). 모든 entries 기준(필터로 가려도 결정 유지).
  const apply = useMemo(() => {
    let create = 0;
    let overwrite = 0;
    const payload: ApplyDecision[] = [];
    for (const e of plan.entries) {
      const dir = decisions[e.rel] ?? defaultDirection(e.status);
      if (dir === "skip") continue;
      payload.push({ rel: e.rel, direction: dir });
      if (isCreate(e.status, dir)) create += 1;
      else overwrite += 1;
    }
    return { create, overwrite, payload };
  }, [plan.entries, decisions]);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            // 기본은 헤더 Close 버튼에 포커스 → ↑↓ 가 죽음. 리스트에 포커스를 줘 즉시 키 내비.
            e.preventDefault();
            listRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
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
              비교 항목이 많아 일부만 표시했습니다 (상한 도달) — 머지/적용은 비활성화됩니다.
            </div>
          )}

          <CompareList
            rows={rows}
            entriesEmpty={plan.entries.length === 0}
            dirOf={dirOf}
            setDir={setDir}
            listRef={listRef}
          />

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-meta text-fg-muted">
              적용: 생성 <b className="text-fg">{apply.create}</b> · 덮어쓰기{" "}
              <b className="text-fg">{apply.overwrite}</b>
              {apply.overwrite > 0 && " (백업 후, undo 가능)"}
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
                className="rounded border border-border px-3 py-1 text-base hover:bg-subtle disabled:opacity-50"
                title={
                  plan.truncated
                    ? "비교가 잘려 머지할 수 없습니다 — 범위를 좁히세요"
                    : "한쪽에만 있는 파일을 양방향으로 복사 (덮어쓰기/삭제 없음, undo 가능)"
                }
              >
                Merge ↔
              </button>
              <button
                type="button"
                onClick={() => onApply(apply.payload)}
                disabled={apply.payload.length === 0 || plan.truncated}
                className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
                title={
                  plan.truncated
                    ? "비교가 잘려 적용할 수 없습니다 — 범위를 좁히세요"
                    : "고른 방향대로 적용 (덮어쓰기는 .bak 백업, undo 가능)"
                }
              >
                Apply ({apply.payload.length})
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
