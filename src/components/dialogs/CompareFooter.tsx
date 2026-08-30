import { useTranslation, Trans } from "react-i18next";
import { DialogButton } from "./DialogButton";

/**
 * 비교창 푸터 — 적용 요약(생성/덮어쓰기)은 `CompareFooterSummary`(DialogShell 의
 * footerLeft), 액션은 `CompareFooterButtons`(footer). truncated 면 Merge/Apply
 * 비활성(부분 작업 방지).
 */
export function CompareFooterSummary({
  create,
  overwrite,
}: {
  create: number;
  overwrite: number;
}) {
  const { t } = useTranslation();
  return (
    <span>
      <Trans
        i18nKey="dialog.compare.applySummary"
        values={{ create, overwrite }}
        components={{
          1: <b className="text-fg" />,
          3: <b className="text-fg" />,
        }}
      />
      {overwrite > 0 && t("dialog.compare.applyBackupNote")}
    </span>
  );
}

export function CompareFooterButtons({
  applyCount,
  mergeable,
  truncated,
  onClose,
  onMerge,
  onApply,
}: {
  applyCount: number;
  mergeable: number;
  truncated: boolean;
  onClose: () => void;
  onMerge: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DialogButton hint="esc" onClick={onClose}>
        {t("common.close")}
      </DialogButton>
      <span
        title={
          truncated
            ? t("dialog.compare.mergeTruncatedTitle")
            : t("dialog.compare.mergeTitle")
        }
      >
        <DialogButton disabled={mergeable === 0 || truncated} onClick={onMerge}>
          {t("dialog.compare.merge")}
        </DialogButton>
      </span>
      <span
        title={
          truncated
            ? t("dialog.compare.applyTruncatedTitle")
            : t("dialog.compare.applyTitle")
        }
      >
        <DialogButton
          tone="primary"
          disabled={applyCount === 0 || truncated}
          onClick={onApply}
        >
          {t("dialog.compare.applyCta", { count: applyCount })}
        </DialogButton>
      </span>
    </>
  );
}
