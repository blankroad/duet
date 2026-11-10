import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FolderInput } from "lucide-react";
import type { ExtractPlanItem } from "@/types/bindings";
import { basename } from "@/lib/paths";
import type { PlanItem } from "@/lib/planItems";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { ItemList } from "./ItemList";

/** 폴더 없이 파일 하나로 풀리는 포맷 — 목록 아이콘용. */
const SINGLE_FILE = new Set(["gz", "bz2", "xz", "zst"]);

export interface ExtractConflictDialogProps {
  items: readonly ExtractPlanItem[];
  onReplace: () => void;
  onKeepBoth: () => void;
  onCancel: () => void;
}

/**
 * 압축 해제 받을 이름이 이미 있을 때 일괄당 한 번 묻는다 — 교체 / 둘 다 유지 / 취소.
 * 교체는 기존 항목을 `.bak` 으로 옮기고(Ctrl+Z 복원), 둘 다 유지는 `이름 (2)` 로 푼다.
 * 기본 포커스는 비파괴인 "둘 다 유지".
 */
export function ExtractConflictDialog({
  items,
  onReplace,
  onKeepBoth,
  onCancel,
}: ExtractConflictDialogProps) {
  const { t } = useTranslation();
  const keepRef = useRef<HTMLButtonElement>(null);
  const taken = useMemo<PlanItem[]>(
    () =>
      items.flatMap((it) =>
        it.plan?.conflict
          ? [
              {
                name: basename(it.plan.dest_dir, it.plan.archive_name),
                kind: SINGLE_FILE.has(it.plan.format) ? "file" : "dir",
                size: null,
              },
            ]
          : [],
      ),
    [items],
  );
  const names = useMemo(() => new Set(taken.map((p) => p.name)), [taken]);
  return (
    <DialogShell
      title={t("dialog.extractConflict.title")}
      subtitle={t("dialog.extractConflict.subtitle", { count: taken.length })}
      icon={FolderInput}
      onClose={onCancel}
      initialFocus={keepRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={onCancel}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton onClick={onReplace}>
            {t("dialog.extractConflict.replace")}
          </DialogButton>
          <DialogButton
            ref={keepRef}
            tone="primary"
            hint="enter"
            onClick={onKeepBoth}
          >
            {t("dialog.extractConflict.keepBoth")}
          </DialogButton>
        </>
      }
    >
      <p className="mb-2 text-base text-fg">
        {t("dialog.extractConflict.body")}
      </p>
      <ItemList
        items={taken}
        badges={names}
        badgeLabel={t("dialog.extractConflict.existing")}
      />
      <p className="mt-2 text-meta text-fg-muted">
        {t("dialog.extractConflict.replaceHint")}
      </p>
    </DialogShell>
  );
}
