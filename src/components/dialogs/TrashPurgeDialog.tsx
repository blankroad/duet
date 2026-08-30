import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { trashItemFor } from "@/lib/trashView";
import type { PlanItem } from "@/lib/planItems";
import { DangerConfirmDialog } from "./DangerConfirmDialog";
import { ItemList } from "./ItemList";

/** 휴지통 영구 삭제 확인 단어 — 백엔드 `PERMANENT_DELETE_CONFIRM_WORD` 와 동일. */
const REQUIRED_WORD = "delete";

/**
 * 휴지통에서 영구 삭제 / 휴지통 비우기 확인 — 되돌릴 수 없으므로 단어 타이핑(§3).
 * `all=true` 면 비우기(대상 목록 없이 개수만).
 */
export function TrashPurgeDialog({
  names,
  all,
  onCancel,
  onConfirm,
}: {
  /** 표시 이름들 (가상 휴지통 목록 기준). all=true 면 무시. */
  names: string[];
  all: boolean;
  onCancel: () => void;
  onConfirm: (typedWord: string) => void;
}) {
  const { t } = useTranslation();
  const items = useMemo<PlanItem[]>(
    () =>
      names.map((name) => {
        const it = trashItemFor(name);
        return { name, kind: it?.kind ?? null, size: it?.size ?? null };
      }),
    [names],
  );
  return (
    <DangerConfirmDialog
      title={
        all ? t("dialog.trashPurge.emptyTitle") : t("dialog.trashPurge.title")
      }
      subtitle={
        all
          ? undefined
          : t("dialog.transfer.summaryCountOnly", { count: names.length })
      }
      warning={t("dialog.trashPurge.body")}
      body={all ? undefined : <ItemList items={items} />}
      requiredWord={REQUIRED_WORD}
      ctaLabel={
        all ? t("dialog.trashPurge.emptyCta") : t("dialog.trashPurge.cta")
      }
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
