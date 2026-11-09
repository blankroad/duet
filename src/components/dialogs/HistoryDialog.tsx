import { useTranslation } from "react-i18next";
import { History, Undo2, Redo2 } from "lucide-react";
import clsx from "clsx";
import { useJournal } from "@/stores/journal";
import { useToast } from "@/stores/toast";
import { triggerUndo, triggerRedo } from "@/lib/fileActions";
import { opLabel } from "@/lib/journalLabel";
import { useKeyHint } from "@/lib/keyHint";
import { formatKeyEvent } from "@/lib/keyEvent";
import { useKeymap, resolveKeyCommand } from "@/stores/keymap";
import { useAllCommands } from "@/stores/commands";
import type { JournalEntry } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";

/**
 * 작업 히스토리 (journal tail) — Ctrl+Z 가 "무엇을" 되돌릴지 누르기 전에
 * 보여주는 읽기 전용 뷰 + Undo 버튼.
 *
 * journal store 는 이벤트로 라이브 갱신되므로 undo 실행 결과가 즉시 반영된다.
 * redo / 임의 항목 undo 는 백엔드 미지원 (undoLast 만) — 후속.
 */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  // 현재 키맵의 키 — 되돌리기를 다시 맨 사용자에게 옛 Ctrl+Z 를 가르치지 않게.
  const undoKey = useKeyHint("edit.undo");
  const redoKey = useKeyHint("edit.redo");
  const entries = useJournal((s) => s.entries);
  const hasUndoable = useJournal((s) => s.hasUndoable);
  const hasRedoable = useJournal((s) => s.hasRedoable);
  const showToast = useToast((s) => s.show);
  const bindings = useKeymap((s) => s.bindings);
  const all = useAllCommands();

  // 최신이 위. "다음 Ctrl+Z 대상" = 아직 안 되돌린 것 중 가장 최근.
  const nextUndoId = [...entries]
    .reverse()
    .find((e) => !e.undone && !e.stale)?.id;
  const newestFirst = [...entries].reverse();

  return (
    <DialogShell
      width="lg"
      bodyFill
      divided
      title={t("history.title")}
      description={t("history.desc")}
      icon={History}
      // 모달 중엔 전역 단축키가 보류되므로(뒤 패널 보호), 이 창이 안내하는 되돌리기/
      // 다시 실행 키는 여기서 직접 받는다 — 키맵 규칙 그대로.
      onKeyDown={(e) => {
        const ks = formatKeyEvent(e.nativeEvent);
        if (!ks) return;
        const id = resolveKeyCommand(ks, bindings, all);
        if (id === "edit.undo" && hasUndoable) {
          e.preventDefault();
          void triggerUndo(showToast);
        } else if (id === "edit.redo" && hasRedoable) {
          e.preventDefault();
          void triggerRedo(showToast);
        }
      }}
      onClose={onClose}
      footerLeft={t("history.redoNote")}
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.close")}
          </DialogButton>
          <DialogButton
            disabled={!hasUndoable}
            onClick={() => void triggerUndo(showToast)}
          >
            <span className="flex items-center gap-1.5">
              <Undo2 size={13} aria-hidden />
              {undoKey
                ? t("history.undoLast", { key: undoKey })
                : t("history.undoLastPlain")}
            </span>
          </DialogButton>
          <DialogButton
            disabled={!hasRedoable}
            onClick={() => void triggerRedo(showToast)}
          >
            <span className="flex items-center gap-1.5">
              <Redo2 size={13} aria-hidden />
              {redoKey
                ? t("history.redoLast", { key: redoKey })
                : t("history.redoLastPlain")}
            </span>
          </DialogButton>
        </>
      }
    >
      {newestFirst.length === 0 ? (
        <div className="py-6 text-center text-base text-fg-muted">
          {t("history.empty")}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {newestFirst.map((e) => (
            <HistoryRow key={e.id} entry={e} isNext={e.id === nextUndoId} />
          ))}
        </ul>
      )}
    </DialogShell>
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
  const undoKey = useKeyHint("edit.undo");
  return (
    <li
      className={clsx(
        "flex items-baseline gap-2 py-1.5 text-base",
        entry.undone && "text-fg-muted line-through opacity-60",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{opLabel(entry.op, t)}</span>
      {entry.stale && (
        <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-meta text-fg-muted">
          {t("history.stale")}
        </span>
      )}
      {isNext && (
        <span className="shrink-0 rounded bg-subtle px-1.5 py-0.5 text-meta text-accent">
          {undoKey
            ? t("history.next", { key: undoKey })
            : t("history.nextPlain")}
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
