import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { formatSize } from "@/lib/format";
import { resolvePlanItems } from "@/lib/planItems";
import type { CopyPlan, Location, MovePlan } from "@/types/bindings";
import { ItemList } from "./ItemList";
import { RouteBlock } from "./RouteBlock";

export type TransferPlan = CopyPlan | MovePlan;

/**
 * 복사/이동 확인 본문 — "어디서 → 어디로" 블록 + 대상 목록.
 *
 * 개수·크기는 제목 아래 요약(transferSummary)으로 올리고, 본문은 사용자가 실제로
 * 확인해야 할 것(경로·파일명)만 남긴다. 받는 위치에 이미 있는 항목은 목록에 배지.
 */
export function TransferPlanBody({ plan }: { plan: TransferPlan }) {
  const { t } = useTranslation();
  const items = useMemo(() => resolvePlanItems(plan.items), [plan]);
  const conflictNames = useMemo(
    () => new Set(plan.conflicts.map((c) => c.name)),
    [plan],
  );
  const first = plan.items[0];
  const src: Location | null = first
    ? { source: plan.src_source, path: first.location.path }
    : null;
  return (
    <>
      <RouteBlock src={src} dst={plan.dst} hint={transferHint(plan, t)} />
      <ItemList
        items={items}
        badges={conflictNames}
        badgeLabel={t("conflict.existsBadge")}
      />
    </>
  );
}

/** "3개 · 4.2 MB" — 총량 미상(0)이면 개수만 (같은 볼륨 이동은 크기를 재지 않는다). */
export function transferSummary(plan: TransferPlan, t: TFunction): string {
  const count = plan.items.length;
  return plan.total_size_bytes > 0
    ? t("dialog.transfer.summary", {
        count,
        size: formatSize(plan.total_size_bytes),
      })
    : t("dialog.transfer.summaryCountOnly", { count });
}

/**
 * 전송 경로를 말로 — "전략: 릴레이" 같은 내부 용어 대신 사용자가 알아야 할 사실만.
 * 같은 호스트 서버측 복사(이 앱의 핵심 가치)는 "이 PC 를 거치지 않음" 으로 드러낸다.
 */
export function transferHint(plan: TransferPlan, t: TFunction): string {
  if ("is_same_fs" in plan && plan.is_same_fs)
    return t("dialog.transfer.hintRename");
  switch (plan.strategy.kind) {
    case "local_to_local":
      return t("dialog.transfer.hintLocal");
    case "relay":
      return t("dialog.transfer.hintRelay");
    case "ssh_same_host":
      return t("dialog.transfer.hintSameHost");
  }
}
