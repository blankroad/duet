import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import type { DeletePlan } from "@/types/bindings";
import { ConfirmDialog } from "./ConfirmDialog";
import { DeletePlanBody, useDeleteSubtitle } from "./DeletePlanBody";

/** 휴지통 삭제 확인 — 위험하지 않으므로(되돌리기 가능) 주 버튼은 accent. */
export function DeleteTrashDialog({
  plan,
  onCancel,
  onConfirm,
}: {
  plan: DeletePlan;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const subtitle = useDeleteSubtitle(plan);
  return (
    <ConfirmDialog
      title={t("dialog.deleteConfirm.title")}
      subtitle={subtitle}
      icon={Trash2}
      body={<DeletePlanBody plan={plan} />}
      ctaLabel={t("common.delete")}
      ctaTone="neutral"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}
