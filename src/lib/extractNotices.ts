import i18n from "@/i18n";
import type { EntryRef, ExtractHereSummary, Location } from "@/types/bindings";
import { sourceKey } from "@/lib/entryDnd";
import { useToast } from "@/stores/toast";

/**
 * "여기에 압축 풀기" 결과 알림을 **일괄당 하나**로 모은다.
 *
 * 백엔드는 아카이브(작업)마다 결과를 `extract-here-notice-event` 로 보낸다(알릴 게 있을
 * 때만). 일괄을 보낼 때 작업 id 들을 등록해 두고, 결과가 오면 그 일괄에 쌓았다가 일괄의
 * 작업이 모두 끝나면(완료·실패·취소) 토스트 하나로 보여준다. 등록된 일괄에 속하지 않는
 * 결과(암호 재시도 작업 등)는 바로 따로 보여준다.
 */

interface Batch {
  /** taskId → 아카이브 키. 끝난 작업은 지운다. */
  pending: Map<string, string>;
  /** 이 일괄의 아카이브 키 — 결과를 일괄에 붙일 때 쓴다(끝난 작업 포함). */
  keys: Set<string>;
  summaries: ExtractHereSummary[];
}

const batches: Batch[] = [];

/** 표시 전용 비교 키 — 경로를 결합하지 않고 (source, 폴더 문자열, 이름) 으로만. */
function archiveKey(dir: Location, name: string): string {
  return `${sourceKey(dir.source)}\u0000${dir.path}\u0000${name}`;
}

/** 방금 건 작업들을 한 일괄로 등록한다. */
export function trackHereBatch(
  tasks: readonly { taskId: string; archive: EntryRef }[],
): void {
  if (tasks.length === 0) return;
  const pending = new Map<string, string>();
  for (const t of tasks)
    pending.set(t.taskId, archiveKey(t.archive.location, t.archive.name));
  batches.push({ pending, keys: new Set(pending.values()), summaries: [] });
}

/** 백엔드 결과 하나 — 일괄에 쌓거나, 속한 일괄이 없으면 바로 보여준다. */
export function noteHereSummary(
  archiveDir: Location,
  summary: ExtractHereSummary,
): void {
  const key = archiveKey(archiveDir, summary.archive_name);
  const batch = batches.find((b) => b.keys.has(key));
  if (batch) batch.summaries.push(summary);
  else showHereNotice([summary]);
}

/** 작업이 끝났다(완료·실패·취소) — 일괄의 마지막이면 모은 결과를 보여준다. */
export function settleHereTask(taskId: string): void {
  const i = batches.findIndex((b) => b.pending.has(taskId));
  if (i < 0) return;
  const batch = batches[i]!;
  batch.pending.delete(taskId);
  if (batch.pending.size > 0) return;
  batches.splice(i, 1);
  if (batch.summaries.length > 0) showHereNotice(batch.summaries);
}

/** 알림 문장 + 자세히 — 테스트용으로 분리. */
export function describeHereNotice(summaries: readonly ExtractHereSummary[]): {
  message: string;
  detail: string;
} {
  const renamed = summaries.flatMap((s) => s.renamed);
  const replaced = summaries.flatMap((s) => s.replaced);
  const skipped = summaries.flatMap((s) => s.skipped);
  const leftovers = summaries.flatMap((s) =>
    s.leftover_staging ? [s.leftover_staging] : [],
  );
  const parts: string[] = [];
  if (renamed.length > 0)
    parts.push(i18n.t("toast.extractHereRenamed", { count: renamed.length }));
  if (replaced.length > 0)
    parts.push(i18n.t("toast.extractHereReplaced", { count: replaced.length }));
  if (skipped.length > 0)
    parts.push(i18n.t("toast.extractHereSkipped", { count: skipped.length }));
  if (leftovers.length > 0)
    parts.push(
      i18n.t("toast.extractHereLeftover", { count: leftovers.length }),
    );
  const names =
    summaries.length === 1
      ? summaries[0]!.archive_name
      : i18n.t("toast.extractHereArchives", { count: summaries.length });
  const detail = [
    ...renamed.map((r) => `${r.from} → ${r.to}`),
    ...replaced.map((r) =>
      i18n.t("toast.extractHereReplacedLine", {
        name: r.name,
        backup: r.backup,
      }),
    ),
    ...skipped.map((s) =>
      i18n.t("toast.extractHereSkippedLine", { name: s.name }),
    ),
    ...leftovers.map((p) =>
      i18n.t("toast.extractHereLeftoverLine", { path: p }),
    ),
  ].join("\n");
  return {
    message: i18n.t("toast.extractHereNotice", {
      name: names,
      details: parts.join(", "),
    }),
    detail,
  };
}

function showHereNotice(summaries: readonly ExtractHereSummary[]): void {
  const { message, detail } = describeHereNotice(summaries);
  const kind = summaries.some((s) => s.leftover_staging) ? "warning" : "info";
  useToast.getState().show(message, kind, { detail });
}

/** 테스트 전용 — 모듈 상태 초기화. */
export function resetExtractNoticesForTest(): void {
  batches.length = 0;
}
