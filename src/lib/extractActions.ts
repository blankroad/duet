import { commands } from "@/types/bindings";
import type {
  Entry,
  EntryRef,
  ExtractConflict,
  ExtractPlanItem,
  SourceId,
} from "@/types/bindings";
import i18n from "@/i18n";
import { canExtractArchive } from "@/lib/archive";
import { explainError } from "@/lib/error";
import { rememberExtract, type ExtractRetry } from "@/lib/extractPending";
import { trackHereBatch } from "@/lib/extractNotices";
import { resolveActiveTargets } from "@/lib/fileActions";
import { computeDisplayed } from "@/stores/panes";
import type { DialogState } from "@/stores/ui-dialogs";
import type { ToastFn } from "@/stores/toast";

/**
 * 압축 해제 두 갈래 — 선택한 아카이브들을
 * - **여기에 풀기**(`triggerExtractHere`): 내용을 아카이브가 있는 폴더에 바로. 이미 있는
 *   항목 정책(둘 다 유지 / 교체 / 건너뛰기)을 늘 한 번 묻는다. 로컬 전용(이번 범위).
 * - **각각 폴더로 풀기**(`triggerExtractToFolders`): 아카이브마다 `<stem>/` 를 옆에.
 *   받을 이름이 이미 있을 때만 교체/둘 다 유지/취소를 묻는다.
 *
 * 공통: 아카이브가 아닌 항목(과 원격에서 못 푸는 형식)은 건너뛰고 한 번 알린다. 아카이브
 * 하나 = 작업 하나 = journal 하나(Ctrl+Z 한 번). 하나가 실패해도 나머지는 진행한다.
 *
 * 실패 알림은 두 갈래다:
 * - 계획·작업 등록 단계 실패 → 일괄이 끝난 뒤 요약 토스트 하나.
 * - 실행 중(task) 실패 → 기존 task 실패 경로(TasksBar·토스트, 암호면 암호 창 대기열).
 */

type OpenFn = (d: DialogState) => void;

const LOCAL: SourceId = { kind: "local" };

/** 건너뛴 항목과 이유 — 아카이브가 아님 / 원격에서 풀 수 없는 형식(7z·rar·단일 파일). */
export interface ExtractSkip {
  name: string;
  reason: "notArchive" | "remote";
}

export interface ExtractSelection {
  archives: EntryRef[];
  skipped: ExtractSkip[];
}

/** 대상 항목을 풀 수 있는 아카이브와 건너뛸 것으로 나눈다 (순서 보존). */
export function classifyForExtract(
  targets: readonly EntryRef[],
  entries: readonly Entry[],
  source: SourceId,
): ExtractSelection {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const archives: EntryRef[] = [];
  const skipped: ExtractSkip[] = [];
  for (const t of targets) {
    const e = byName.get(t.name);
    if (!e || e.kind !== "file" || !canExtractArchive(t.name, LOCAL)) {
      skipped.push({ name: t.name, reason: "notArchive" });
    } else if (!canExtractArchive(t.name, source)) {
      skipped.push({ name: t.name, reason: "remote" });
    } else {
      archives.push(t);
    }
  }
  return { archives, skipped };
}

/** 이 이름들 중 이 위치에서 풀 수 있는 아카이브 수 — 메뉴 항목 노출·개수 표시용. */
export function countExtractable(
  names: Iterable<string>,
  entries: readonly Entry[],
  source: SourceId,
): number {
  const byName = new Map(entries.map((e) => [e.name, e]));
  let n = 0;
  for (const name of names) {
    const e = byName.get(name);
    if (e?.kind === "file" && canExtractArchive(name, source)) n += 1;
  }
  return n;
}

/** "여기에 풀기" 를 이 위치에서 제공하는가 — 원격은 이번 범위 밖(SFTP rename 미검증). */
export function canExtractHereAt(source: SourceId): boolean {
  return source.kind === "local";
}

/** 활성 패널의 대상(선택 또는 cursor)을 화면 순서대로 분류. */
function resolveExtractSelection(): ExtractSelection & { source: SourceId } {
  const { tab, targets } = resolveActiveTargets();
  const order = new Map(computeDisplayed(tab).map((e, i) => [e.name, i]));
  const sorted = [...targets].sort(
    (a, b) =>
      (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    ...classifyForExtract(sorted, tab.entries, tab.location.source),
    source: tab.location.source,
  };
}

function skipToast(skipped: readonly ExtractSkip[], showToast: ToastFn): void {
  if (skipped.length === 0) return;
  const allNonArchive = skipped.every((s) => s.reason === "notArchive");
  const key = allNonArchive
    ? "toast.extractSkippedNonArchive"
    : "toast.extractSkipped";
  const detail = skipped
    .map(
      (s) =>
        `${s.name}: ${i18n.t(
          s.reason === "remote"
            ? "toast.extractSkipRemote"
            : "toast.extractSkipNotArchive",
        )}`,
    )
    .join("\n");
  showToast(i18n.t(key, { count: skipped.length }), "info", { detail });
}

/** 선택을 분류하고 건너뛴 것을 알린다. 풀 아카이브가 없으면 null. */
function takeSelection(showToast: ToastFn): {
  archives: EntryRef[];
  source: SourceId;
} | null {
  const { archives, skipped, source } = resolveExtractSelection();
  skipToast(skipped, showToast);
  if (archives.length === 0) {
    if (skipped.length === 0) showToast(i18n.t("toast.extractSelectArchive"));
    return null;
  }
  return { archives, source };
}

// === 여기에 풀기 ===

/** 우클릭 "여기에 압축 풀기" — 정책 다이얼로그를 연다(실행은 `runExtractHere`). */
export function triggerExtractHere(open: OpenFn, showToast: ToastFn): void {
  const sel = takeSelection(showToast);
  if (!sel) return;
  if (!canExtractHereAt(sel.source)) {
    showToast(i18n.t("toast.extractHereLocalOnly"), "info");
    return;
  }
  open({ kind: "extract-here", archives: sel.archives });
}

/** 정책을 받아 아카이브마다 작업을 건다. 시작 전 거부는 모아서 요약 하나. */
export async function runExtractHere(
  archives: readonly EntryRef[],
  policy: ExtractConflict,
  showToast: ToastFn,
): Promise<void> {
  const r = await commands.fsExtractHere([...archives], policy);
  if (r.status === "error") {
    failedToast(r.error, showToast);
    return;
  }
  const failed: Failure[] = [];
  const started: { taskId: string; archive: EntryRef }[] = [];
  for (const d of r.data) {
    if (d.task_id) {
      rememberExtract(d.task_id, {
        retry: {
          kind: "here",
          archive: d.archive,
          policy,
          batch: [...archives],
        },
        attempted: false,
      });
      started.push({ taskId: d.task_id, archive: d.archive });
    } else {
      failed.push({ name: d.archive.name, error: d.error });
    }
  }
  trackHereBatch(started);
  summaryToast(failed, archives.length, showToast);
}

// === 각각 폴더로 풀기 ===

/** 우클릭 "폴더로 압축 풀기" / "각각 폴더로 압축 풀기 (k)". */
export async function triggerExtractToFolders(
  open: OpenFn,
  showToast: ToastFn,
): Promise<void> {
  const sel = takeSelection(showToast);
  if (!sel) return;
  const r = await commands.fsExtractPlanBatch(sel.archives, false);
  if (r.status === "error") {
    failedToast(r.error, showToast);
    return;
  }
  if (r.data.some((it) => it.plan?.conflict)) {
    open({ kind: "extract-conflict", items: r.data });
    return;
  }
  await runExtractBatch(r.data, showToast);
}

/**
 * 충돌 다이얼로그의 선택. 교체 = 받은 계획 그대로(기존은 실행 시 `.bak`, Ctrl+Z 로 복원).
 * 둘 다 유지 = `keep_both` 로 다시 계획해 `a (2)` 같은 빈 이름으로(실행 때 다시 예약).
 * 취소는 호출하지 않는다 — 아무것도 실행하지 않는다.
 */
export async function resolveExtractConflict(
  choice: "replace" | "keepBoth",
  items: readonly ExtractPlanItem[],
  showToast: ToastFn,
): Promise<void> {
  if (choice === "replace") {
    await runExtractBatch(items, showToast);
    return;
  }
  const r = await commands.fsExtractPlanBatch(
    items.map((it) => it.archive),
    true,
  );
  if (r.status === "error") {
    failedToast(r.error, showToast);
    return;
  }
  await runExtractBatch(r.data, showToast);
}

/** 계획된 항목마다 task 를 건다. 계획·등록 실패는 모아서 마지막에 한 번 알린다. */
export async function runExtractBatch(
  items: readonly ExtractPlanItem[],
  showToast: ToastFn,
): Promise<void> {
  const failed: Failure[] = [];
  for (const it of items) {
    if (!it.plan) {
      failed.push({ name: it.archive.name, error: it.error });
      continue;
    }
    // 1차 시도는 암호 없이 — 암호 zip 이면 task 가 NeedPassword 로 실패하고
    // useTaskEvents 가 여기서 기억한 plan 으로 암호 창(대기열)을 연다.
    const exec = await commands.fsExtractExecute(it.plan, null);
    if (exec.status === "error") {
      failed.push({ name: it.archive.name, error: exec.error });
      continue;
    }
    rememberExtract(exec.data, {
      retry: { kind: "folder", plan: it.plan },
      attempted: false,
    });
  }
  summaryToast(failed, items.length, showToast);
}

// === 암호 재시도 ===

/**
 * 암호 창의 입력으로 같은 해제를 다시 건다 (폴더로 = 같은 plan, 여기에 = 같은 정책·일괄).
 * 반환 = 새 작업 id, 또는 시작 전 에러. 암호는 인자로만 지나간다(§5).
 */
export async function retryExtract(
  retry: ExtractRetry,
  password: string,
): Promise<{ ok: true; taskId: string } | { ok: false; error: unknown }> {
  const r =
    retry.kind === "folder"
      ? await commands.fsExtractExecute(retry.plan, password)
      : await commands.fsExtractHereRetry(
          retry.archive,
          retry.policy,
          password,
          retry.batch,
        );
  if (r.status === "error") return { ok: false, error: r.error };
  rememberExtract(r.data, { retry, attempted: true });
  return { ok: true, taskId: r.data };
}

// === 알림 ===

interface Failure {
  name: string;
  error: unknown;
}

/** 시작 전 실패 요약 — 하나뿐인 일괄이면 그 원인을, 여럿이면 이름 목록 + 자세히. */
function summaryToast(
  failed: readonly Failure[],
  total: number,
  showToast: ToastFn,
): void {
  if (failed.length === 0) return;
  if (total === 1) {
    failedToast(failed[0]!.error, showToast);
    return;
  }
  const detail = failed
    .map((f) => `${f.name}: ${explainError(f.error).text}`)
    .join("\n");
  showToast(
    i18n.t("toast.extractBatchFailed", {
      count: failed.length,
      names: failed.map((f) => f.name).join(", "),
    }),
    "error",
    { detail },
  );
}

function failedToast(error: unknown, showToast: ToastFn): void {
  const why = explainError(error);
  showToast(i18n.t("toast.extractFailed", { err: why.text }), "error", {
    detail: why.detail,
  });
}
