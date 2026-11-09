import type { TFunction } from "i18next";
import type { Location, OpKind, UndoOutcome } from "@/types/bindings";
import type { ToastKind } from "@/stores/toast";
import { basename } from "@/lib/paths";

/** 작업 위치의 표시용 짧은 이름. */
export const shortLoc = (l: Location) => basename(String(l.path), "/");

/** journal op 을 한 줄 요약 — 미지의 op kind 는 kind 문자열 fallback. */
export function opLabel(op: OpKind, t: TFunction): string {
  switch (op.kind) {
    case "trash":
      return t("history.op.trash", {
        count: op.count,
        loc: shortLoc(op.location),
      });
    case "permanent_delete":
      return t("history.op.permanentDelete", {
        count: op.count,
        loc: shortLoc(op.location),
      });
    case "copy":
      return t("history.op.copy", { count: op.count, loc: shortLoc(op.dst) });
    case "move":
      return t("history.op.move", { count: op.count, loc: shortLoc(op.dst) });
    case "rename":
      return t("history.op.rename", { from: op.from, to: op.to });
    case "batch_rename":
      return t("history.op.batchRename", {
        count: op.count,
        loc: shortLoc(op.location),
      });
    case "mkdir":
      return t("history.op.mkdir", { name: basename(op.path, op.path) });
    case "new_file":
      return t("history.op.newFile", { name: basename(op.path, op.path) });
    case "extract":
      return t("history.op.extract", {
        name: basename(String(op.archive.path), "archive"),
      });
    case "compress":
      return t("history.op.compress", {
        count: op.count,
        loc: shortLoc(op.dst),
      });
    case "sync":
      return op.pruned > 0
        ? t("history.op.syncPruned", {
            count: op.count,
            pruned: op.pruned,
            loc: shortLoc(op.dst),
          })
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

/** 구조화된 undo/redo 결과를 사용자 문구로 표시하고 백엔드 메모는 상세로 보존한다. */
export function undoToast(
  outcome: UndoOutcome,
  direction: "undo" | "redo",
  t: TFunction,
): { message: string; kind: ToastKind; detail?: string } {
  const op = outcome.op ? opLabel(outcome.op, t) : t("undo.unknownOperation");
  const first = outcome.skipped[0];
  const reasonCode = outcome.reason ?? first?.reason ?? "failed";
  const mixedPartial =
    outcome.kind === "partial" &&
    new Set(outcome.skipped.map((item) => item.reason)).size > 1;
  const reason = t(`undo.reason.${mixedPartial ? "mixed" : reasonCode}`);
  let message: string;
  switch (outcome.kind) {
    case "ok":
      message = t(`undo.${direction}.ok`, { op });
      break;
    case "partial":
      message = t(`undo.${direction}.partial`, {
        op,
        count: outcome.skipped.length,
        reason,
        item: first ? t("undo.item", { name: basename(first.path) }) : "",
      });
      break;
    case "stale":
      message = t(`undo.${direction}.stale`, { op, reason });
      break;
    case "irreversible":
      message = t("undo.irreversible", { op });
      break;
    case "skipped":
      if (reasonCode === "nothing_to_undo" || reasonCode === "nothing_to_redo")
        message = reason;
      else if (reasonCode === "redo_unsupported")
        message = t("undo.redoUnsupported", { op });
      else message = t(`undo.${direction}.skipped`, { op, reason });
      break;
    case "error":
      message = t(`undo.${direction}.error`, { op, reason });
      break;
  }
  const shownSkipped = mixedPartial ? outcome.skipped.slice(0, 5) : [];
  const skippedDetails = shownSkipped.map(
    (item) => `${basename(item.path)}: ${t(`undo.reason.${item.reason}`)}`,
  );
  const remaining = outcome.skipped.length - shownSkipped.length;
  if (mixedPartial && remaining > 0)
    skippedDetails.push(t("notices.more", { count: remaining }));
  const hasWarningNote =
    mixedPartial ||
    (Boolean(outcome.message) &&
      ["partial", "stale", "irreversible"].includes(outcome.kind));
  const detail =
    outcome.kind === "error" || hasWarningNote
      ? [outcome.message, ...skippedDetails].filter(Boolean).join("\n")
      : "";
  return {
    message,
    kind:
      outcome.kind === "ok"
        ? "success"
        : outcome.kind === "error"
          ? "error"
          : hasWarningNote
            ? "warning"
            : "info",
    ...(detail ? { detail } : {}),
  };
}
