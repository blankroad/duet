import type { TFunction } from "i18next";
import type { Location, OpKind } from "@/types/bindings";
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
