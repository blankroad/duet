import { useTranslation } from "react-i18next";
import type { DeletePlan } from "@/types/bindings";
import { DangerConfirmDialog } from "./DangerConfirmDialog";
import { DeletePlanBody, useDeleteSubtitle } from "./DeletePlanBody";

/** 확인 단어 — 백엔드가 같은 단어를 검증한다 (CLAUDE.md §3). */
const REQUIRED_WORD = "delete";

/** 영구 삭제 확인 — 단어 타이핑 전까지 주 버튼 비활성. */
export function DeletePermanentDialog({
  plan,
  onCancel,
  onConfirm,
}: {
  plan: DeletePlan;
  onCancel: () => void;
  onConfirm: (typedWord: string) => void;
}) {
  const { t } = useTranslation();
  const subtitle = useDeleteSubtitle(plan);
  return (
    <DangerConfirmDialog
      title={t("dialog.deleteDanger.title")}
      subtitle={subtitle}
      warning={t("dialog.deleteDanger.body")}
      body={<DeletePlanBody plan={plan} />}
      requiredWord={REQUIRED_WORD}
      ctaLabel={t("dialog.deleteDanger.cta")}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
