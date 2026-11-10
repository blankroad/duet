import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus2, FolderInput, Replace, SkipForward } from "lucide-react";
import type { EntryRef, ExtractConflict } from "@/types/bindings";
import type { PlanItem } from "@/lib/planItems";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { ItemList } from "./ItemList";
import { Segmented, type SegmentedOption } from "./Segmented";

export interface ExtractHereDialogProps {
  archives: readonly EntryRef[];
  onConfirm: (policy: ExtractConflict) => void;
  onCancel: () => void;
}

const HINT: Record<ExtractConflict, string> = {
  keep_both: "dialog.extractHere.keepBothHint",
  replace: "dialog.extractHere.replaceHint",
  skip: "dialog.extractHere.skipHint",
};

/**
 * "여기에 압축 풀기" — 풀 아카이브 목록과, 이미 있는 항목을 만났을 때의 정책(일괄당 하나).
 * 미리 아카이브 목록을 읽지 않으므로 충돌 여부와 무관하게 늘 묻는다. 기본 = 둘 다 유지.
 * Enter = 확인 (주 버튼 포커스).
 */
export function ExtractHereDialog({
  archives,
  onConfirm,
  onCancel,
}: ExtractHereDialogProps) {
  const { t } = useTranslation();
  const ctaRef = useRef<HTMLButtonElement>(null);
  const [policy, setPolicy] = useState<ExtractConflict>("keep_both");
  const items = useMemo<PlanItem[]>(
    () => archives.map((a) => ({ name: a.name, kind: "file", size: null })),
    [archives],
  );
  const options: SegmentedOption<ExtractConflict>[] = [
    { value: "keep_both", label: t("conflict.keepBoth"), icon: FilePlus2 },
    { value: "replace", label: t("dialog.extractHere.replace"), icon: Replace },
    { value: "skip", label: t("conflict.skip"), icon: SkipForward },
  ];
  return (
    <DialogShell
      title={t("dialog.extractHere.title")}
      subtitle={t("dialog.extractHere.subtitle", { count: archives.length })}
      icon={FolderInput}
      onClose={onCancel}
      initialFocus={ctaRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={onCancel}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            ref={ctaRef}
            tone="primary"
            hint="enter"
            onClick={() => onConfirm(policy)}
          >
            {t("dialog.extractHere.cta")}
          </DialogButton>
        </>
      }
    >
      <ItemList items={items} />
      <p className="mb-1.5 mt-3 text-meta text-fg-muted">
        {t("dialog.extractHere.existing")}
      </p>
      <Segmented
        size="lg"
        fill
        value={policy}
        options={options}
        onChange={setPolicy}
      />
      <p className="mt-1.5 text-meta text-fg-muted">{t(HINT[policy])}</p>
    </DialogShell>
  );
}
