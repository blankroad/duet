import * as Dialog from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { X, History, Undo2 } from "lucide-react";
import clsx from "clsx";
import { useJournal } from "@/stores/journal";
import { useToast } from "@/stores/toast";
import { triggerUndo } from "@/lib/fileActions";
import { basename } from "@/lib/paths";
import { displayKey } from "@/lib/keyDisplay";
import type { JournalEntry, Location, OpKind } from "@/types/bindings";

/**
 * 작업 히스토리 (journal tail) — Ctrl+Z 가 "무엇을" 되돌릴지 누르기 전에
 * 보여주는 읽기 전용 뷰 + Undo 버튼.
 *
 * journal store 는 이벤트로 라이브 갱신되므로 undo 실행 결과가 즉시 반영된다.
 * redo / 임의 항목 undo 는 백엔드 미지원 (undoLast 만) — 후속.
 */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const entries = useJournal((s) => s.entries);
  const hasUndoable = useJournal((s) => s.hasUndoable);
  const showToast = useToast((s) => s.show);

  // 최신이 위. "다음 Ctrl+Z 대상" = 아직 안 되돌린 것 중 가장 최근.
  const nextUndoId = [...entries].reverse().find((e) => !e.undone)?.id;
  const newestFirst = [...entries].reverse();

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[70vh] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base shadow-lg focus:outline-none">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <History size={15} className="text-fg-muted" aria-hidden />
            <Dialog.Title className="text-title font-medium">
              {t("history.title")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="ml-auto rounded p-1 text-fg-muted hover:bg-border"
                aria-label={t("common.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {newestFirst.length === 0 ? (
              <div className="px-4 py-6 text-center text-base text-fg-muted">
                {t("history.empty")}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {newestFirst.map((e) => (
                  <HistoryRow key={e.id} entry={e} isNext={e.id === nextUndoId} />
                ))}
              </ul>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
            <span className="text-meta text-fg-muted">
              {t("history.redoNote")}
            </span>
            <button
              type="button"
              disabled={!hasUndoable}
              onClick={() => void triggerUndo(showToast)}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded border border-border px-3 py-1 text-base hover:bg-subtle disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Undo2 size={13} aria-hidden />
              {t("history.undoLast", { key: displayKey("Ctrl+Z") })}
            </button>
          </div>
          <Dialog.Description className="sr-only">
            Journal of recent file operations
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HistoryRow({
  entry,
  isNext,
}: {
  entry: JournalEntry;
  isNext: boolean;
}) {
  const { t } = useTranslation();
  return (
    <li
      className={clsx(
        "flex items-baseline gap-2 px-4 py-1.5 text-base",
        entry.undone && "text-fg-muted line-through opacity-60",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{opLabel(entry.op, t)}</span>
      {isNext && (
        <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-meta text-accent">
          {t("history.next", { key: displayKey("Ctrl+Z") })}
        </span>
      )}
      <span className="shrink-0 text-meta text-fg-muted">
        {formatStamp(entry.timestamp)}
      </span>
    </li>
  );
}

/** RFC3339 timestamp → 로컬 간결 표기 (오늘이면 시간만). */
function formatStamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

const shortLoc = (l: Location) => basename(String(l.path), "/");

/** journal op 을 한 줄 요약 — 미지의 op kind 는 kind 문자열 fallback. */
function opLabel(op: OpKind, t: TFunction): string {
  switch (op.kind) {
    case "trash":
      return t("history.op.trash", { count: op.count, loc: shortLoc(op.location) });
    case "permanent_delete":
      return t("history.op.permanentDelete", { count: op.count, loc: shortLoc(op.location) });
    case "copy":
      return t("history.op.copy", { count: op.count, loc: shortLoc(op.dst) });
    case "move":
      return t("history.op.move", { count: op.count, loc: shortLoc(op.dst) });
    case "rename":
      return t("history.op.rename", { from: op.from, to: op.to });
    case "batch_rename":
      return t("history.op.batchRename", { count: op.count, loc: shortLoc(op.location) });
    case "mkdir":
      return t("history.op.mkdir", { name: basename(op.path, op.path) });
    case "extract":
      return t("history.op.extract", { name: basename(String(op.archive.path), "archive") });
    case "compress":
      return t("history.op.compress", { count: op.count, loc: shortLoc(op.dst) });
    case "sync":
      return op.pruned > 0
        ? t("history.op.syncPruned", { count: op.count, pruned: op.pruned, loc: shortLoc(op.dst) })
        : t("history.op.sync", { count: op.count, loc: shortLoc(op.dst) });
    case "merge":
      return t("history.op.merge", { count: op.to_left + op.to_right });
    case "compare_apply":
      return t("history.op.compareApply", { count: op.applied });
    case "three_way_apply":
      return t("history.op.threeWayApply", { count: op.applied });
    default:
      return (op as { kind: string }).kind.replace(/_/g, " ");
  }
}
