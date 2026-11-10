import { useMemo, useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { FolderGit2 } from "lucide-react";
import clsx from "clsx";
import {
  commands,
  type ApplyDecision,
  type ApplyDirection,
  type CompareEntry,
  type CompareRules,
  type ComparePlan,
  type CompareStatus,
} from "@/types/bindings";
import {
  DIFF_STATUSES,
  strategyBadge,
  defaultDirection,
  isCreate,
} from "./compareView";
import { CompareList } from "./CompareList";
import { basename } from "@/lib/paths";
import { formatErr } from "@/lib/error";
import { hasRemoteSide } from "@/lib/compareRules";
import { CompareTree } from "./CompareTree";
import { CompareRulesBar } from "./CompareRulesBar";
import { CompareFilterBar } from "./CompareFilterBar";
import { CompareFooterSummary, CompareFooterButtons } from "./CompareFooter";
import { DialogShell } from "./DialogShell";
import { DialogBand } from "./DialogBand";
import { CompareDiffPreview } from "./CompareDiffPreview";

const EMPTY_RULES: CompareRules = { ignore_globs: [], mtime_tolerance_ms: 0 };

export interface CompareDialogProps {
  plan: ComparePlan;
  onClose: () => void;
  /** 이 plan 을 만든 비교 규칙(무시 패턴·허용오차). 없으면 빈 규칙. */
  rules?: CompareRules;
  /**
   * 양방향 머지 실행 — 한쪽에만 있는 파일을 반대편으로 복사(충돌 미변경).
   * `rules` = 지금 목록을 만든 규칙: 머지가 숨긴 항목까지 다시 찾아 복사하지 않게(SC-07).
   */
  onMerge: (detectRenames: boolean, rules: CompareRules) => void;
  /** 행별 방향 적용 — 생성 + 덮어쓰기(백업, undo 가능). */
  onApply: (decisions: ApplyDecision[]) => void;
}

/**
 * 두 패널 폴더 비교 결과 — 상태 필터칩 + 경로검색 + 양쪽 메타 + 행별 방향 적용.
 * 리스트/키보드는 CompareList 가 담당. 머지/적용은 truncated 면 비활성.
 */
export function CompareDialog({
  plan: initialPlan,
  rules: initialRules = EMPTY_RULES,
  onClose,
  onMerge,
  onApply,
}: CompareDialogProps) {
  const { t } = useTranslation();
  // plan 은 규칙 변경 시 Re-compare 로 교체되므로 로컬 상태로 보유(seed=prop).
  const [plan, setPlan] = useState(initialPlan);
  // 지금 목록(plan)을 만든 규칙 — 다시 비교가 성공할 때만 바뀐다(실패면 목록도 그대로).
  const rulesRef = useRef(initialRules);
  const [recomparing, setRecomparing] = useState(false);
  // 이동/이름변경 감지(기본 off). 토글 후 Re-compare 로 적용(머지에도 동일 적용).
  const [detectRenames, setDetectRenames] = useState(false);
  // 행별 적용 방향 — **사용자가 직접 고른 것만** 담는다(없으면 상태별 기본값).
  // 다시 비교·검증으로 행 상태가 바뀌면 그 행의 선택은 버린다: 예전엔 첫 plan 의
  // 기본 방향이 남아, 이제 "같음"(기본 필터에서 숨김)이 된 파일까지 덮어썼다.
  const [decisions, setDecisions] = useState<Record<string, ApplyDirection>>(
    {},
  );
  // 최신 plan 과 그 세대 — 다시 비교가 시작되면 세대가 바뀌어, 그 전에 나간 검증·
  // 다시 비교 응답은 버린다(늦게 온 검증이 새 결과를 옛 목록으로 되돌리던 문제).
  const planRef = useRef(plan);
  planRef.current = plan;
  const genRef = useRef(0);
  const replacePlan = (next: ComparePlan) => {
    const before = new Map(
      planRef.current.entries.map((e) => [e.rel, e.status]),
    );
    planRef.current = next;
    setDecisions((prev) => {
      const kept: Record<string, ApplyDirection> = {};
      for (const e of next.entries) {
        const d = prev[e.rel];
        if (d !== undefined && before.get(e.rel) === e.status) kept[e.rel] = d;
      }
      return kept;
    });
    setPlan(next);
  };

  const onRecompare = async (rules: CompareRules) => {
    const gen = ++genRef.current;
    setRecomparing(true);
    const r = await commands.fsCompareDirs(
      plan.left,
      plan.right,
      rules,
      detectRenames,
    );
    if (gen !== genRef.current) return; // 더 새 다시 비교가 이어받음
    if (r.status === "ok") {
      rulesRef.current = rules;
      replacePlan(r.data);
      setVerifyNote(null);
    } else {
      setVerifyNote(
        t("dialog.compare.recompareFailed", { err: formatErr(r.error) }),
      );
    }
    setRecomparing(false);
  };

  const moves = plan.moves ?? [];

  // 내용 검증 — Same 항목을 해시/바이트로 재검증해 '틀린 Same' 을 Differ 로 격상.
  const [verifying, setVerifying] = useState(false);
  const [verifyNote, setVerifyNote] = useState<string | null>(null);
  const onVerify = async () => {
    const sameRels = plan.entries
      .filter((e) => e.status === "same")
      .map((e) => e.rel);
    if (sameRels.length === 0) return;
    setVerifying(true);
    setVerifyNote(null);
    const gen = genRef.current;
    const r = await commands.fsCompareVerify(plan.left, plan.right, sameRels);
    if (gen !== genRef.current) {
      // 검증하는 사이 다시 비교로 목록이 바뀌었다 — 옛 목록 기준 결과라 버린다.
      setVerifyNote(t("dialog.compare.verifyStale"));
      setVerifying(false);
      return;
    }
    if (r.status === "ok") {
      const differ = new Set(
        r.data.filter((v) => v.equal === false).map((v) => v.rel),
      );
      const unver = r.data.filter((v) => v.equal === null).length;
      if (differ.size > 0) {
        const cur = planRef.current;
        replacePlan({
          ...cur,
          entries: cur.entries.map((e) =>
            differ.has(e.rel) && e.status === "same"
              ? { ...e, status: "differ" as const }
              : e,
          ),
        });
      }
      setVerifyNote(
        t("dialog.compare.verified", {
          count: sameRels.length,
          differ: differ.size,
        }) +
          (unver > 0 ? t("dialog.compare.unverifiable", { count: unver }) : ""),
      );
    } else {
      setVerifyNote(
        t("dialog.compare.verifyFailed", { err: formatErr(r.error) }),
      );
    }
    setVerifying(false);
  };

  // 비교 결과 CSV/JSON 내보내기 — OS 저장 다이얼로그로 경로 선택 후 backend 가 기록.
  const onExport = async () => {
    const dest = await save({
      defaultPath: "compare.csv",
      filters: [
        { name: "CSV", extensions: ["csv"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (!dest) return;
    const format = dest.toLowerCase().endsWith(".json") ? "json" : "csv";
    const r = await commands.fsExportCompare(plan, dest, format);
    setVerifyNote(
      r.status === "ok"
        ? t("dialog.compare.exported", { dest })
        : t("dialog.compare.exportFailed", { err: formatErr(r.error) }),
    );
  };

  // 기본 필터: 차이만(same 숨김). unreadable 은 경고라 기본 표시.
  const [active, setActive] = useState<Set<CompareStatus>>(
    () => new Set<CompareStatus>([...DIFF_STATUSES, "unreadable"]),
  );
  const [query, setQuery] = useState("");
  // 인라인 미리보기 — 선택 행(CompareList 가 보고) + 표시 토글.
  const [selectedEntry, setSelectedEntry] = useState<CompareEntry | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  // 보기 모드 — 평면 목록(키보드 내비) / 디렉토리 트리(접기·롤업).
  const [view, setView] = useState<"list" | "tree">("list");
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
      (e) =>
        active.has(e.status) && (q === "" || e.rel.toLowerCase().includes(q)),
    );
  }, [plan.entries, active, query]);

  const mergeable = plan.left_only + plan.right_only;
  const badge = strategyBadge(plan.strategy, t);
  const base = (loc: { path: string }) => basename(String(loc.path));

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
    <DialogShell
      width="2xl"
      bodyFill
      title={t("dialog.compare.title")}
      description={t("dialog.compare.desc")}
      icon={FolderGit2}
      onClose={onClose}
      // 기본은 첫 버튼에 포커스 → ↑↓ 가 죽음. 리스트에 포커스를 줘 즉시 키 내비.
      initialFocus={listRef}
      headerRight={
        <span
          className={clsx("rounded border px-1.5 py-0.5 text-meta", badge.tone)}
          title={badge.title}
        >
          {badge.label}
        </span>
      }
      footerLeft={
        <CompareFooterSummary
          create={apply.create}
          overwrite={apply.overwrite}
        />
      }
      footer={
        <CompareFooterButtons
          applyCount={apply.payload.length}
          mergeable={mergeable}
          truncated={plan.truncated}
          onClose={onClose}
          onMerge={() => onMerge(detectRenames, rulesRef.current)}
          onApply={() => onApply(apply.payload)}
        />
      }
    >
      <div className="grid grid-cols-2 gap-2 text-meta">
        <div className="truncate">
          <span className="text-fg-muted">{t("dialog.compare.left")} </span>
          <span className="font-mono" title={String(plan.left.path)}>
            {base(plan.left)}
          </span>
        </div>
        <div className="truncate text-right">
          <span className="font-mono" title={String(plan.right.path)}>
            {base(plan.right)}
          </span>
          <span className="text-fg-muted"> {t("dialog.compare.right")}</span>
        </div>
      </div>

      <CompareFilterBar
        counts={counts}
        active={active}
        toggle={toggle}
        query={query}
        setQuery={setQuery}
      />

      <CompareRulesBar
        onRecompare={onRecompare}
        busy={recomparing}
        remote={hasRemoteSide(plan.left, plan.right)}
      />

      <div className="flex items-center gap-2 text-meta text-fg-muted">
        <button
          type="button"
          onClick={() => void onVerify()}
          disabled={counts.same === 0 || verifying}
          className="rounded border border-border px-2 py-0.5 hover:bg-subtle disabled:opacity-50"
          title={t("dialog.compare.verifyTitle")}
        >
          {verifying
            ? t("dialog.compare.verifying")
            : t("dialog.compare.verifyCta", { count: counts.same })}
        </button>
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          aria-pressed={showPreview}
          className={clsx(
            "rounded border px-2 py-0.5 hover:bg-subtle",
            showPreview ? "border-border bg-subtle text-fg" : "border-border",
          )}
          title={t("dialog.compare.previewTitle")}
        >
          {t("dialog.compare.preview")}
        </button>
        <button
          type="button"
          onClick={() => setView((v) => (v === "list" ? "tree" : "list"))}
          className="rounded border border-border px-2 py-0.5 hover:bg-subtle"
          title={t("dialog.compare.viewToggleTitle")}
        >
          {view === "list"
            ? t("dialog.compare.treeView")
            : t("dialog.compare.listView")}
        </button>
        <label
          className="flex items-center gap-1 text-fg-muted"
          title={t("dialog.compare.detectMovesTitle")}
        >
          <input
            type="checkbox"
            checked={detectRenames}
            onChange={(e) => setDetectRenames(e.target.checked)}
          />
          {t("dialog.compare.detectMoves")}
        </label>
        <button
          type="button"
          onClick={() => void onExport()}
          className="rounded border border-border px-2 py-0.5 hover:bg-subtle"
          title={t("dialog.compare.exportTitle")}
        >
          {t("dialog.compare.export")}
        </button>
        {verifyNote && <span className="truncate">{verifyNote}</span>}
      </div>

      {counts.unreadable > 0 && (
        <DialogBand
          tone="danger"
          message={t("dialog.compare.unreadable", { count: counts.unreadable })}
        />
      )}
      {plan.truncated && (
        <DialogBand tone="warning" message={t("dialog.compare.truncated")} />
      )}

      {moves.length > 0 && (
        <div className="max-h-20 overflow-auto rounded-panel border border-border bg-subtle/40 px-2 py-1 text-meta">
          <div className="text-fg-muted">
            <Trans
              i18nKey="dialog.compare.moves"
              values={{ count: moves.length }}
              components={{ 1: <b className="text-fg" /> }}
            />
          </div>
          {moves.map((m) => (
            <div
              key={`${m.from_rel}=>${m.to_rel}`}
              className="truncate font-mono text-fg-muted"
              title={`${m.from_rel} ⇒ ${m.to_rel}`}
            >
              {m.from_rel} <span className="text-accent">⇒</span> {m.to_rel}
            </div>
          ))}
        </div>
      )}

      {view === "tree" ? (
        <CompareTree
          rows={rows}
          dirOf={dirOf}
          setDir={setDir}
          onSelect={setSelectedEntry}
        />
      ) : (
        <CompareList
          rows={rows}
          entriesEmpty={plan.entries.length === 0}
          dirOf={dirOf}
          setDir={setDir}
          listRef={listRef}
          onSelect={setSelectedEntry}
        />
      )}

      {showPreview && (
        <CompareDiffPreview
          entry={selectedEntry}
          left={plan.left}
          right={plan.right}
        />
      )}
    </DialogShell>
  );
}
