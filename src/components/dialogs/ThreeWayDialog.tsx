import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import * as Dialog from "@radix-ui/react-dialog";
import { X, GitMerge, AlertTriangle } from "lucide-react";
import clsx from "clsx";
import type { ThreeWayPlan, ThreeWayStatus } from "@/types/bindings";
import { basename } from "@/lib/paths";

const LABEL_KEY: Record<ThreeWayStatus, string> = {
  unchanged: "",
  left_changed: "dialog.threeWay.status.leftChanged",
  right_changed: "dialog.threeWay.status.rightChanged",
  both_changed: "dialog.threeWay.status.bothChanged",
  left_added: "dialog.threeWay.status.leftAdded",
  right_added: "dialog.threeWay.status.rightAdded",
  add_conflict: "dialog.threeWay.status.addConflict",
  left_deleted: "dialog.threeWay.status.leftDeleted",
  right_deleted: "dialog.threeWay.status.rightDeleted",
  delete_conflict: "dialog.threeWay.status.deleteConflict",
};

const TONE: Record<ThreeWayStatus, string> = {
  unchanged: "text-fg-muted",
  left_changed: "text-accent",
  right_changed: "text-accent",
  both_changed: "text-danger",
  left_added: "text-accent",
  right_added: "text-accent",
  add_conflict: "text-danger",
  left_deleted: "text-warning",
  right_deleted: "text-warning",
  delete_conflict: "text-danger",
};

const CONFLICT_SET = new Set<ThreeWayStatus>([
  "both_changed",
  "add_conflict",
  "delete_conflict",
]);

/**
 * 3-way 비교 결과 — base 대비 left/right 변화를 '추가 vs 삭제'까지 구별해 표시.
 * 읽기 전용(자동해결/충돌 적용은 후속). 충돌만 보기 토글.
 */
export function ThreeWayDialog({
  plan,
  onClose,
  onApply,
}: {
  plan: ThreeWayPlan;
  onClose: () => void;
  /** 자동 해결 가능분 적용 (충돌 제외). */
  onApply: () => void;
}) {
  const { t } = useTranslation();
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const base = (loc: { path: string }) => basename(String(loc.path));
  const rows = plan.entries.filter(
    (e) => !onlyConflicts || CONFLICT_SET.has(e.status),
  );

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-2 flex items-start justify-between">
            <Dialog.Title className="flex items-center gap-1.5 text-title font-medium">
              <GitMerge size={15} /> {t("dialog.threeWay.title")}
            </Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label={t("common.close")}
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="mb-2 flex flex-wrap gap-x-3 text-meta text-fg-muted">
            <span>
              {t("dialog.threeWay.base")}{" "}
              <span
                className="font-mono text-fg"
                title={String(plan.base.path)}
              >
                {base(plan.base)}
              </span>
            </span>
            <span>
              {t("dialog.threeWay.left")}{" "}
              <span
                className="font-mono text-fg"
                title={String(plan.left.path)}
              >
                {base(plan.left)}
              </span>
            </span>
            <span>
              {t("dialog.threeWay.right")}{" "}
              <span
                className="font-mono text-fg"
                title={String(plan.right.path)}
              >
                {base(plan.right)}
              </span>
            </span>
          </div>

          <div className="mb-2 flex items-center gap-3 text-meta">
            <span className="text-fg-muted">
              <Trans
                i18nKey="dialog.threeWay.autoResolved"
                values={{ count: plan.auto }}
                components={{ 1: <b className="text-fg" /> }}
              />
            </span>
            <span
              className={clsx(
                plan.conflicts > 0 ? "text-danger" : "text-fg-muted",
              )}
            >
              <Trans
                i18nKey="dialog.threeWay.conflicts"
                values={{ count: plan.conflicts }}
                components={{ 1: <b /> }}
              />
            </span>
            {plan.conflicts > 0 && (
              <label className="ml-auto flex items-center gap-1 text-fg-muted">
                <input
                  type="checkbox"
                  checked={onlyConflicts}
                  onChange={(e) => setOnlyConflicts(e.target.checked)}
                />
                {t("dialog.threeWay.conflictsOnly")}
              </label>
            )}
          </div>

          {plan.truncated && (
            <div className="mb-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-meta text-warning">
              {t("dialog.threeWay.truncated")}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto rounded border border-border">
            {rows.length === 0 ? (
              <div className="px-2 py-3 text-center text-meta text-fg-muted">
                {plan.entries.length === 0
                  ? t("dialog.threeWay.noDiff")
                  : t("dialog.threeWay.noItems")}
              </div>
            ) : (
              <table className="w-full text-meta">
                <tbody>
                  {rows.map((e, i) => (
                    <tr key={`${e.rel}:${i}`} className="even:bg-subtle/40">
                      <td
                        className={clsx(
                          "w-28 px-2 py-0.5 font-medium",
                          TONE[e.status],
                        )}
                      >
                        <span className="flex items-center gap-1">
                          {CONFLICT_SET.has(e.status) && (
                            <AlertTriangle size={10} />
                          )}
                          {LABEL_KEY[e.status] && t(LABEL_KEY[e.status])}
                        </span>
                      </td>
                      <td
                        className="truncate px-2 py-0.5 font-mono"
                        title={e.rel}
                      >
                        {e.kind === "dir" ? `${e.rel}/` : e.rel}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-meta text-fg-muted">
              {t("dialog.threeWay.applyNote", { count: plan.conflicts })}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
              >
                {t("common.close")}
              </button>
              <button
                type="button"
                onClick={onApply}
                disabled={plan.auto === 0 || plan.truncated}
                className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
                title={
                  plan.truncated
                    ? t("dialog.threeWay.truncatedTitle")
                    : t("dialog.threeWay.applyTitle")
                }
              >
                {t("dialog.threeWay.applyCta", { count: plan.auto })}
              </button>
            </div>
          </div>
          <Dialog.Description className="sr-only">
            {t("dialog.threeWay.desc")}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
