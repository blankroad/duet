import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Copy, ListChecks, MoveRight } from "lucide-react";
import clsx from "clsx";
import type { ConflictPolicy } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { Segmented } from "./Segmented";
import { DialogBand } from "./DialogBand";
import { ConflictPerFileList, policyOptions } from "./ConflictPerFileList";
import {
  TransferPlanBody,
  transferSummary,
  type TransferPlan,
} from "./TransferPlanBody";

const POLICY_HINT: Record<ConflictPolicy, string> = {
  skip: "conflict.skipAllHint",
  keepboth: "conflict.keepBothAllHint",
  replace: "conflict.replaceAllHint",
};

/**
 * 복사/이동 확인 다이얼로그.
 *
 * - 충돌 없음: [취소] [복사].
 * - 충돌 있음(일괄): 경고 밴드 안에서 정책을 세그먼트로 고르고(기본 건너뛰기 —
 *   아무것도 덮어쓰거나 새로 만들지 않는 안전한 시작점) 주 버튼은 그대로 [복사].
 *   교체를 고르면 힌트와 주 버튼이 danger 로 바뀐다 — 영구 덮어쓰기(undo 불가).
 * - 파일별: "파일별로 선택…" 으로 전환 → 항목마다 정책 → onConfirmPerFile(decisions).
 */
export function CopyMoveConfirmDialog({
  kind,
  plan,
  onCancel,
  onConfirm,
  onConfirmPerFile,
}: {
  kind: "copy" | "move";
  plan: TransferPlan;
  onCancel: () => void;
  onConfirm: (policy: ConflictPolicy) => void;
  onConfirmPerFile: (decisions: Record<string, ConflictPolicy>) => void;
}) {
  const { t } = useTranslation();
  const ctaRef = useRef<HTMLButtonElement>(null);
  const conflicts = plan.conflicts;
  const cta = t(`dialog.transfer.${kind}`);
  const [policy, setPolicy] = useState<ConflictPolicy>("skip");
  const [perFile, setPerFile] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, ConflictPolicy>>(
    () => Object.fromEntries(conflicts.map((c) => [c.name, "skip" as const])),
  );

  const cancelBtn = (
    <DialogButton hint="esc" onClick={onCancel}>
      {t("common.cancel")}
    </DialogButton>
  );

  if (perFile) {
    const tally = { replace: 0, skip: 0, keepboth: 0 };
    for (const c of conflicts) tally[decisions[c.name] ?? "skip"]++;
    return (
      <DialogShell
        title={t("conflict.perFileTitle", { cta })}
        subtitle={t("conflict.perFileSummary", {
          count: conflicts.length,
          rest: plan.items.length - conflicts.length,
        })}
        icon={ListChecks}
        onClose={onCancel}
        // `replace` 는 i18next 예약 옵션(보간 값 묶음) — 변수명에 쓰면 보간이 깨진다.
        footerLeft={t("conflict.tally", {
          nReplace: tally.replace,
          nSkip: tally.skip,
          nKeep: tally.keepboth,
        })}
        footer={
          <>
            {cancelBtn}
            <DialogButton
              tone={tally.replace > 0 ? "danger" : "primary"}
              hint="enter"
              onClick={() => onConfirmPerFile(decisions)}
            >
              {cta}
            </DialogButton>
          </>
        }
      >
        <ConflictPerFileList
          conflicts={conflicts}
          decisions={decisions}
          onChange={(name, p) => setDecisions((d) => ({ ...d, [name]: p }))}
          onSetAll={(p) =>
            setDecisions(Object.fromEntries(conflicts.map((c) => [c.name, p])))
          }
        />
        {tally.replace > 0 && (
          <div className="flex items-center gap-1.5 text-meta text-danger">
            <AlertTriangle size={12} className="shrink-0" />
            <span>{t("conflict.replaceWarn", { count: tally.replace })}</span>
          </div>
        )}
      </DialogShell>
    );
  }

  const hasConflicts = conflicts.length > 0;
  const destructive = hasConflicts && policy === "replace";
  return (
    <DialogShell
      title={cta}
      subtitle={transferSummary(plan, t)}
      icon={kind === "copy" ? Copy : MoveRight}
      onClose={onCancel}
      initialFocus={ctaRef}
      footer={
        <>
          {cancelBtn}
          <DialogButton
            ref={ctaRef}
            tone={destructive ? "danger" : "primary"}
            hint="enter"
            onClick={() => onConfirm(hasConflicts ? policy : "replace")}
          >
            {cta}
          </DialogButton>
        </>
      }
    >
      <TransferPlanBody plan={plan} />
      {hasConflicts && (
        <DialogBand
          tone="warning"
          message={t("conflict.exist", { count: conflicts.length })}
        >
          {/* 되돌릴 수 없는 "교체" 가 섞인 결정 — 세 칸을 한눈에 보이게 크게(lg) 두고,
              고른 것의 결과는 바로 아래 한 줄로 설명한다. */}
          <div className="flex flex-col gap-2">
            <Segmented
              size="lg"
              fill
              value={policy}
              options={policyOptions(t)}
              onChange={setPolicy}
            />
            <div className="flex items-center gap-2.5">
              <span
                className={clsx(
                  "min-w-0 flex-1 text-meta",
                  destructive ? "text-danger" : "text-fg-muted",
                )}
              >
                {t(POLICY_HINT[policy])}
              </span>
              <button
                type="button"
                onClick={() => setPerFile(true)}
                className="shrink-0 text-meta text-accent hover:underline"
              >
                {t("conflict.perFile")}
              </button>
            </div>
          </div>
        </DialogBand>
      )}
    </DialogShell>
  );
}
