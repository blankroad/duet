import { useMemo } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Undo2 } from "lucide-react";
import { formatSize } from "@/lib/format";
import { shortenPath } from "@/lib/paths";
import { useHostLabel } from "@/lib/hostLabel";
import { displayKey } from "@/lib/keyDisplay";
import { resolvePlanItems } from "@/lib/planItems";
import type { DeletePlan } from "@/types/bindings";
import { ItemList } from "./ItemList";

/**
 * 삭제 확인 본문 — 무엇을 지우는지 목록으로. 휴지통 모드면 되돌리기 안내를 덧붙여
 * "안전한 작업은 무마찰" 톤을 유지한다 (원격은 `~/.duet-trash` 로 이동 — CLAUDE.md §3).
 */
export function DeletePlanBody({ plan }: { plan: DeletePlan }) {
  const items = useMemo(() => resolvePlanItems(plan.targets), [plan]);
  const remote = plan.source.kind !== "local";
  return (
    <>
      <ItemList items={items} />
      {plan.mode === "trash" && (
        <div className="flex items-center gap-1.5 text-meta text-fg-muted">
          <Undo2 size={12} className="shrink-0" />
          <span>
            <Trans
              i18nKey={
                remote
                  ? "dialog.deleteConfirm.undoHintRemote"
                  : "dialog.deleteConfirm.undoHint"
              }
              values={{ key: displayKey("Ctrl+Z") }}
              components={{
                1: (
                  <kbd className="rounded-[3px] border border-border bg-subtle px-1 font-mono text-fg" />
                ),
                2: <span className="font-mono" />,
              }}
            />
          </span>
        </div>
      )}
    </>
  );
}

/** 제목 아래 요약: "3개 · 4.2 MB · Local ~/Downloads". */
export function useDeleteSubtitle(plan: DeletePlan): string {
  const { t } = useTranslation();
  const host = useHostLabel(plan.source);
  const summary =
    plan.total_size_bytes > 0
      ? t("dialog.transfer.summary", {
          count: plan.total_count,
          size: formatSize(plan.total_size_bytes),
        })
      : t("dialog.transfer.summaryCountOnly", { count: plan.total_count });
  return `${summary} · ${host} ${shortenPath(plan.source_location.path, 32)}`;
}
