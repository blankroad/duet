import { commands } from "@/types/bindings";
import type { DeleteMode, EntryRef, Location } from "@/types/bindings";
import { usePanes, activeTab, computeDisplayed, isParentEntry, PARENT_NAME, type PaneId } from "@/stores/panes";
import type { DialogState } from "@/stores/ui-dialogs";
import { formatErr } from "@/lib/error";

type OpenFn = (d: DialogState) => void;
type ToastFn = (msg: string) => void;

/**
 * 파괴적/생성 작업 트리거 — 키보드(useDestructiveKeys)와 툴바(PaneToolbar)가 공유.
 * plan 호출까지만 — execute 는 App.tsx 의 dialog 핸들러가 진행 (CLAUDE.md §3/§4).
 *
 * 모두 "활성 패널의 선택(set) 또는 cursor 단일 항목"을 대상으로 동작.
 */

interface ActiveCtx {
  active: PaneId;
  opposite: PaneId;
  tab: ReturnType<typeof activeTab>;
  targets: EntryRef[];
}

/** 활성 패널의 대상 항목 + 반대 패널 id 해석. */
export function resolveActiveTargets(): ActiveCtx {
  const state = usePanes.getState();
  const active = state.activePane;
  const opposite: PaneId = active === "left" ? "right" : "left";
  const tab = activeTab(state, active);
  // cursorIndex 는 displayed(정렬/필터/".." 포함) 기준 — raw entries 인덱싱 금지.
  const cursorEntry = computeDisplayed(tab)[tab.cursorIndex];
  const names = (
    tab.selected.size > 0
      ? Array.from(tab.selected)
      : cursorEntry && !isParentEntry(cursorEntry)
        ? [cursorEntry.name]
        : []
  ).filter((n) => n !== PARENT_NAME); // ".." 는 작업 대상에서 제외
  const targets: EntryRef[] = names.map((name) => ({ location: tab.location, name }));
  return { active, opposite, tab, targets };
}

/** F2 — 단일 선택만 rename. */
export function triggerRename(open: OpenFn, showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length !== 1) {
    showToast("Rename: select exactly one item");
    return;
  }
  open({ kind: "rename", target: targets[0]! });
}

/** 여러 항목 일괄 이름변경 — 규칙/미리보기 다이얼로그 오픈 (1개 이상). */
export function triggerBatchRename(open: OpenFn, showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length === 0) {
    showToast("Batch rename: select at least one item");
    return;
  }
  open({ kind: "batch-rename", targets });
}

/** 두 패널 폴더 비교 — 활성=left, 반대=right. 결과를 비교 다이얼로그로. */
export async function triggerCompare(open: OpenFn, showToast: ToastFn): Promise<void> {
  const { active, opposite } = resolveActiveTargets();
  const state = usePanes.getState();
  const left = activeTab(state, active).location;
  const right = activeTab(state, opposite).location;
  const r = await commands.fsCompareDirs(left, right);
  if (r.status === "error") {
    showToast(`Compare: ${formatErr(r.error)}`);
    return;
  }
  open({ kind: "compare", plan: r.data });
}

/** 단방향 미러 — 활성 패널 dir → 반대 패널 dir. plan 후 확인 다이얼로그. */
export async function triggerSync(open: OpenFn, showToast: ToastFn): Promise<void> {
  const { active, opposite } = resolveActiveTargets();
  const state = usePanes.getState();
  const src = activeTab(state, active).location;
  const dst = activeTab(state, opposite).location;
  const r = await commands.fsSyncPlan(src, dst);
  if (r.status === "error") {
    showToast(`Sync: ${formatErr(r.error)}`);
    return;
  }
  const label = (loc: Location) => String(loc.path).split("/").filter(Boolean).pop() ?? "/";
  open({ kind: "sync-confirm", plan: r.data, srcLabel: label(src), dstLabel: label(dst) });
}

/** F7 — 활성 패널 현재 디렉토리에 새 폴더. */
export function triggerMkdir(open: OpenFn): void {
  const { tab } = resolveActiveTargets();
  open({ kind: "mkdir", parent: tab.location });
}

/** targets 를 dst 로 복사/이동 plan 호출 후 확인 다이얼로그. 키보드·툴바·DnD 공유. */
export async function planTransferTo(
  targets: EntryRef[],
  dst: Location,
  mode: "copy" | "move",
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  if (targets.length === 0) return;
  if (mode === "move") {
    const r = await commands.fsMovePlan(targets, dst);
    if (r.status === "ok") open({ kind: "move-confirm", plan: r.data });
    else showToast(`Move plan failed: ${formatErr(r.error)}`);
  } else {
    const r = await commands.fsCopyPlan(targets, dst);
    if (r.status === "ok") open({ kind: "copy-confirm", plan: r.data });
    else showToast(`Copy plan failed: ${formatErr(r.error)}`);
  }
}

/** F5 — 반대 패널로 복사. */
export async function triggerCopy(open: OpenFn, showToast: ToastFn): Promise<void> {
  const { opposite, targets } = resolveActiveTargets();
  const dst: Location = activeTab(usePanes.getState(), opposite).location;
  await planTransferTo(targets, dst, "copy", open, showToast);
}

/** F6 — 반대 패널로 이동. */
export async function triggerMove(open: OpenFn, showToast: ToastFn): Promise<void> {
  const { opposite, targets } = resolveActiveTargets();
  const dst: Location = activeTab(usePanes.getState(), opposite).location;
  await planTransferTo(targets, dst, "move", open, showToast);
}

/** 단일 아카이브 압축 해제 — plan 후 바로 task 로 실행 (진행은 TasksBar). */
export async function triggerExtract(showToast: ToastFn): Promise<void> {
  const { targets } = resolveActiveTargets();
  if (targets.length !== 1) {
    showToast("Extract: select one archive");
    return;
  }
  const plan = await commands.fsExtractPlan(targets[0]!);
  if (plan.status === "error") {
    showToast(`Extract failed: ${formatErr(plan.error)}`);
    return;
  }
  const exec = await commands.fsExtractExecute(plan.data);
  if (exec.status === "error") showToast(`Extract failed: ${formatErr(exec.error)}`);
}

/** 선택 항목들을 압축 — 이름/포맷 선택 다이얼로그 오픈. */
export function triggerCompress(open: OpenFn, showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length === 0) {
    showToast("Compress: select at least one item");
    return;
  }
  // 단일 항목이면 그 이름, 여러 개면 부모 폴더 이름을 기본 아카이브 이름으로.
  const defaultName =
    targets.length === 1
      ? targets[0]!.name
      : String(targets[0]!.location.path).split("/").filter(Boolean).pop() ?? "archive";
  open({ kind: "compress", items: targets, defaultName });
}

/** Delete(trash) / Shift+Delete(permanent). */
export async function triggerDelete(
  mode: DeleteMode,
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const { targets } = resolveActiveTargets();
  if (targets.length === 0) return;
  const r = await commands.fsDeletePlan(targets, mode);
  if (r.status === "ok") {
    open({ kind: mode === "permanent" ? "delete-danger" : "delete-confirm", plan: r.data });
  } else {
    showToast(`Delete plan failed: ${formatErr(r.error)}`);
  }
}
