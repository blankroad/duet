import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { Loader2 } from "lucide-react";
import { commands, events } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";

/**
 * 폴더 비교 스캔 중 표시 — 누적 항목 수(CompareProgressEvent) + 취소.
 * 취소 시 fsCompareCancel → 진행 중인 fsCompareDirs 가 Cancelled 로 반환되어
 * triggerCompare 가 다이얼로그를 닫는다.
 */
export function CompareScanningDialog() {
  const { t } = useTranslation();
  const [scanned, setScanned] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const unlistenP = events.compareProgressEvent.listen(({ payload }) => {
      if (!cancelled) setScanned(payload.scanned);
    });
    return () => {
      cancelled = true;
      void unlistenP.then((u) => u());
    };
  }, []);

  const cancel = () => void commands.fsCompareCancel();

  return (
    <DialogShell
      width="sm"
      title={t("dialog.compareScan.title")}
      description={t("dialog.compareScan.desc")}
      icon={Loader2}
      iconTone="accent"
      iconClassName="animate-spin"
      onClose={cancel}
      footer={
        <DialogButton hint="esc" onClick={cancel}>
          {t("common.cancel")}
        </DialogButton>
      }
    >
      <div className="text-meta text-fg-muted">
        <Trans
          i18nKey="dialog.compareScan.scanned"
          values={{ count: scanned.toLocaleString() }}
          components={{ 1: <b className="tabular-nums text-fg" /> }}
        />
      </div>
    </DialogShell>
  );
}
