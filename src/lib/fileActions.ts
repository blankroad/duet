import { commands } from "@/types/bindings";
import type { DeleteMode, EntryRef, Location } from "@/types/bindings";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  isParentEntry,
  PARENT_NAME,
  type PaneId,
} from "@/stores/panes";
import type { DialogState } from "@/stores/ui-dialogs";
import { childLocation, sameLocation, sourceKey } from "@/lib/entryDnd";
import { formatErr } from "@/lib/error";
import { useClipboard } from "@/stores/clipboard";
import { useShelf } from "@/stores/shelf";

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
  const targets: EntryRef[] = names.map((name) => ({
    location: tab.location,
    name,
  }));
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

/** F2 — 단일이면 rename, 다중이면 batch rename (단축키 한 개로 통합). */
export function triggerRenameSmart(open: OpenFn, showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length > 1) triggerBatchRename(open, showToast);
  else triggerRename(open, showToast);
}

/** Ctrl+Z — 마지막 파괴적 작업 되돌리기 (다이얼로그 없이 toast). */
export async function triggerUndo(showToast: ToastFn): Promise<void> {
  const r = await commands.undoLast();
  if (r.status === "ok") showToast(r.data.message ?? `Undone (${r.data.kind})`);
  else showToast(`Undo failed: ${formatErr(r.error)}`);
}

async function copyToClipboard(
  text: string,
  showToast: ToastFn,
  label: string,
): Promise<void> {
  if (!text) {
    showToast(`${label}: nothing selected`);
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast(`Copied ${label.toLowerCase()}`);
  } catch {
    showToast("Clipboard unavailable");
  }
}

/**
 * targets 의 전체 경로를 클립보드로 (여러 개는 줄바꿈).
 *
 * 로컬은 **백엔드**에서 결합(`local_abs_paths` → Rust `Path::join`) — 이래야 Windows
 * 드라이브문자(`C:`)와 네이티브 구분자(`\`)가 보존된다. 프론트에서 `/`로 join 하면
 * 비-네이티브 경로가 나와 붙여넣기 시 깨진다(§7: 경로 결합은 백엔드 담당).
 * SSH 는 POSIX 라 프론트 join 으로 충분.
 */
export async function copyPathsOf(
  targets: EntryRef[],
  showToast: ToastFn,
): Promise<void> {
  if (targets.length === 0) {
    showToast("Path: nothing selected");
    return;
  }
  // 경로 텍스트는 forward-slash 로 통일 — D:/test/test1/test2. 백엔드 Path::join 은
  // 드라이브를 *추가하지 못하고* 구분자만 섞어(D:/a\b) 오히려 망가뜨렸다. childLocation
  // 은 location.path 의 드라이브를 그대로 보존하고, 마지막에 모든 `\`→`/` 로 정규화.
  const paths = targets.map((t) =>
    String(childLocation(t.location, t.name).path).replace(/\\/g, "/"),
  );
  await copyToClipboard(paths.join("\n"), showToast, "Path");
}

/** 활성 패널 선택 항목의 전체 경로 복사. */
export async function copySelectionPaths(showToast: ToastFn): Promise<void> {
  await copyPathsOf(resolveActiveTargets().targets, showToast);
}

/** 선택 항목의 이름을 클립보드로. */
export async function copySelectionNames(showToast: ToastFn): Promise<void> {
  const { targets } = resolveActiveTargets();
  const text = targets.map((t) => t.name).join("\n");
  await copyToClipboard(text, showToast, "Name");
}

// ── 파일 클립보드 (Ctrl+C / Ctrl+X / Ctrl+V) ─────────────────────────────────
// OS 클립보드가 아니라 인앱 큐. 붙여넣기는 planTransferTo 로 — 기존 복사/이동 확인
// 다이얼로그 + journal(§4) 을 그대로 탄다.

const plural = (n: number) => (n === 1 ? "" : "s");

/** Ctrl+C — 활성 패널 선택을 'copy' 로 클립보드에 담는다(원본 유지). */
export function clipCopy(showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length === 0) {
    showToast("Copy: nothing selected");
    return;
  }
  useClipboard.getState().set(targets, "copy");
  showToast(
    `Copied ${targets.length} item${plural(targets.length)} — paste with Ctrl+V`,
  );
}

/** Ctrl+X — 활성 패널 선택을 'move'(잘라내기) 로 담는다(붙여넣으면 원본 제거). */
export function clipCut(showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length === 0) {
    showToast("Cut: nothing selected");
    return;
  }
  useClipboard.getState().set(targets, "move");
  showToast(
    `Cut ${targets.length} item${plural(targets.length)} — paste with Ctrl+V`,
  );
}

/** Ctrl+V — 클립보드 항목을 활성 패널 현재 폴더로 붙여넣기(copy/move, 확인 다이얼로그 경유). */
export async function clipPaste(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const clip = useClipboard.getState().entry;
  if (!clip || clip.targets.length === 0) {
    showToast("Clipboard is empty — copy with Ctrl+C first");
    return;
  }
  const { tab } = resolveActiveTargets();
  const dst = tab.location;
  // 같은 폴더로 잘라내기-붙여넣기는 의미 없음(no-op).
  if (
    clip.mode === "move" &&
    clip.targets.every((t) => sameLocation(t.location, dst))
  ) {
    showToast("Already in this folder");
    return;
  }
  await planTransferTo(clip.targets, dst, clip.mode, open, showToast);
  // 잘라내기는 한 번 붙여넣으면 소비. 복사는 유지(여러 번 붙여넣기 가능, 탐색기와 동일).
  if (clip.mode === "move") useClipboard.getState().clear();
}

/** 두 패널 폴더 비교 — 활성=left, 반대=right. 결과를 비교 다이얼로그로. */
export async function triggerCompare(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const { active, opposite } = resolveActiveTargets();
  const state = usePanes.getState();
  const left = activeTab(state, active).location;
  const right = activeTab(state, opposite).location;
  // 스캔 중 다이얼로그(진행률+취소) 표시 — 대형/원격 트리에서 UI 멈춤 방지.
  open({ kind: "compare-scanning" });
  // 저장된 비교 규칙으로 초기 비교(없으면 빈 규칙). 비교창에서 Re-compare 로 갱신/저장.
  let rules = { ignore_globs: [] as string[], mtime_tolerance_ms: 0 };
  const sg = await commands.settingsGet();
  if (sg.status === "ok") {
    rules = {
      ignore_globs: sg.data.compare_ignore_globs ?? [],
      mtime_tolerance_ms: sg.data.compare_mtime_tolerance_ms ?? 0,
    };
  }
  const r = await commands.fsCompareDirs(left, right, rules, false);
  if (r.status === "error") {
    // 취소는 조용히 닫기, 그 외는 토스트.
    if (r.error.kind !== "Cancelled")
      showToast(`Compare: ${formatErr(r.error)}`);
    open({ kind: "none" });
    return;
  }
  open({ kind: "compare", plan: r.data });
}

/** 3-way 비교 — base(공통 조상) 대비 left/right. base 경로는 left 소스 기준. */
export async function triggerThreeWay(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const { active, opposite } = resolveActiveTargets();
  const state = usePanes.getState();
  const left = activeTab(state, active).location;
  const right = activeTab(state, opposite).location;
  const input = window.prompt(
    "Base (common ancestor) directory path — relative to the left source:",
    String(left.path),
  );
  if (input == null || input.trim() === "") return;
  const baseLoc: Location = { source: left.source, path: input.trim() };
  const r = await commands.fsCompareThreeWay(baseLoc, left, right);
  if (r.status === "error") {
    showToast(`3-way: ${formatErr(r.error)}`);
    return;
  }
  open({ kind: "three-way", plan: r.data });
}

/** 단방향 미러 — 활성 패널 dir → 반대 패널 dir. plan 후 확인 다이얼로그. */
export async function triggerSync(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const { active, opposite } = resolveActiveTargets();
  const state = usePanes.getState();
  const src = activeTab(state, active).location;
  const dst = activeTab(state, opposite).location;
  const r = await commands.fsSyncPlan(src, dst);
  if (r.status === "error") {
    showToast(`Sync: ${formatErr(r.error)}`);
    return;
  }
  const label = (loc: Location) =>
    String(loc.path).split("/").filter(Boolean).pop() ?? "/";
  open({
    kind: "sync-confirm",
    plan: r.data,
    srcLabel: label(src),
    dstLabel: label(dst),
  });
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
  const verb = mode === "move" ? "Move" : "Copy";
  // 선택/커서 대상이 없으면 조용히 끝나던 것 → 이유를 알린다 ("아무 일 없음" 방지).
  if (targets.length === 0) {
    showToast(`${verb}: nothing selected`);
    return;
  }
  try {
    if (mode === "move") {
      const r = await commands.fsMovePlan(targets, dst);
      if (r.status === "ok") open({ kind: "move-confirm", plan: r.data });
      else showToast(`Move plan failed: ${formatErr(r.error)}`);
    } else {
      const r = await commands.fsCopyPlan(targets, dst);
      if (r.status === "ok") open({ kind: "copy-confirm", plan: r.data });
      else showToast(`Copy plan failed: ${formatErr(r.error)}`);
    }
  } catch (e) {
    // commands.* 가 구조화된 DuetError 대신 예외를 throw 한 경우(명령 미등록·직렬화
    // 실패 등). 호출부가 `void` 라 잡지 않으면 unhandled rejection 으로 조용히 사라짐
    // — 토스트로 노출해 진짜 원인을 보이게 한다.
    showToast(`${verb} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Drop Stack / Shelf ───────────────────────────────────────────────────────

/** 활성 패널 선택(또는 cursor)을 선반에 담는다(여러 위치·호스트 누적). */
export function addSelectionToShelf(showToast: ToastFn): void {
  const { targets } = resolveActiveTargets();
  if (targets.length === 0) {
    showToast("Shelf: nothing selected");
    return;
  }
  const n = useShelf.getState().add(targets);
  const total = useShelf.getState().items.length;
  showToast(
    n === 0
      ? "이미 선반에 있음"
      : `선반에 ${n}개 담음 (총 ${total})`,
  );
}

/**
 * 선반 항목을 활성 패널 현재 폴더로 복사/이동.
 * fs_copy_plan 은 단일 소스 가정 → 소스별 그룹화 후 첫 그룹을 확인 다이얼로그로 적용.
 * 다른 소스 그룹은 선반에 남기고 토스트 안내(혼합 소스 순차 적용은 후속).
 */
export async function applyShelfTo(
  mode: "copy" | "move",
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const items = useShelf.getState().items;
  if (items.length === 0) {
    showToast("선반이 비어 있음");
    return;
  }
  const dst = resolveActiveTargets().tab.location;
  const groups = new Map<string, EntryRef[]>();
  for (const it of items) {
    const k = sourceKey(it.location.source);
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const groupList = [...groups.values()];
  await planTransferTo(groupList[0]!, dst, mode, open, showToast);
  if (groupList.length > 1) {
    showToast(
      `다른 소스 ${groupList.length - 1}개 그룹은 선반에 남음 — 다시 적용하세요`,
    );
  }
}

/** F5 — 반대 패널로 복사. */
export async function triggerCopy(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const { opposite, targets } = resolveActiveTargets();
  const dst: Location = activeTab(usePanes.getState(), opposite).location;
  await planTransferTo(targets, dst, "copy", open, showToast);
}

/** F6 — 반대 패널로 이동. */
export async function triggerMove(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
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
  if (exec.status === "error")
    showToast(`Extract failed: ${formatErr(exec.error)}`);
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
      : (String(targets[0]!.location.path).split("/").filter(Boolean).pop() ??
        "archive");
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
    open({
      kind: mode === "permanent" ? "delete-danger" : "delete-confirm",
      plan: r.data,
    });
  } else {
    showToast(`Delete plan failed: ${formatErr(r.error)}`);
  }
}
