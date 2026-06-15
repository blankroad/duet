import { useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, FolderGit2 } from "lucide-react";
import clsx from "clsx";
import {
  commands,
  type ApplyDecision,
  type ApplyDirection,
  type CompareRules,
  type ComparePlan,
  type CompareStatus,
} from "@/types/bindings";
import { DIFF_STATUSES, strategyBadge, defaultDirection, isCreate } from "./compareView";
import { CompareList } from "./CompareList";
import { CompareRulesBar } from "./CompareRulesBar";
import { CompareFilterBar } from "./CompareFilterBar";
import { CompareFooter } from "./CompareFooter";

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
export function CompareDialog({
  plan: initialPlan,
  onClose,
  onMerge,
  onApply,
}: CompareDialogProps) {
  // plan 은 규칙 변경 시 Re-compare 로 교체되므로 로컬 상태로 보유(seed=prop).
  const [plan, setPlan] = useState(initialPlan);
  const [recomparing, setRecomparing] = useState(false);

  const onRecompare = async (rules: CompareRules) => {
    setRecomparing(true);
    const r = await commands.fsCompareDirs(plan.left, plan.right, rules);
    if (r.status === "ok") setPlan(r.data);
    setRecomparing(false);
  };

  // 내용 검증 — Same 항목을 해시/바이트로 재검증해 '틀린 Same' 을 Differ 로 격상.
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const onVerify = async () => {
    const sameRels = plan.entries.filter((e) => e.status === "same").map((e) => e.rel);
    if (sameRels.length === 0) return;
    setVerifying(true);
    setVerifyNote(null);
    const r = await commands.fsCompareVerify(plan.left, plan.right, sameRels);
    if (r.status === "ok") {
      const differ = new Set(r.data.filter((v) => v.equal === false).map((v) => v.rel));
      const unver = r.data.filter((v) => v.equal === null).length;
      if (differ.size > 0) {
        setPlan((p) => ({
          ...p,
          entries: p.entries.map((e) =>
            differ.has(e.rel) && e.status === "same" ? { ...e, status: "differ" as const } : e,
          ),
        }));
      }
      setVerifyNote(
        `검증 ${sameRels.length}개 — 실제로 다름 ${differ.size}` +
          (unver > 0 ? `, 검증불가 ${unver}` : ""),
      );
    } else {
      setVerifyNote(`검증 실패: ${r.error.kind}`);
    }
    setVerifying(false);
  };

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

          <CompareFilterBar
            counts={counts}
            active={active}
            toggle={toggle}
            query={query}
            setQuery={setQuery}
          />

          <CompareRulesBar onRecompare={onRecompare} busy={recomparing} />

          <div className="mb-2 flex items-center gap-2 text-meta text-fg-muted">
            <button
              type="button"
              onClick={() => void onVerify()}
              disabled={counts.same === 0 || verifying}
              className="rounded border border-border px-2 py-0.5 hover:bg-subtle disabled:opacity-50"
              title="Same 로 분류된 항목의 내용을 해시/바이트로 재검증 (틀린 Same 잡기). same-host 는 host-side sha256(PC 다운로드 0)."
            >
              {verifying ? "검증 중…" : `내용 검증 (Same ${counts.same})`}
            </button>
            {verifyNote && <span>{verifyNote}</span>}
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

          <CompareFooter
            create={apply.create}
            overwrite={apply.overwrite}
            applyCount={apply.payload.length}
            mergeable={mergeable}
            truncated={plan.truncated}
            onClose={onClose}
            onMerge={onMerge}
            onApply={() => onApply(apply.payload)}
          />
          <Dialog.Description className="sr-only">
            Recursive comparison of the two pane directories.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
