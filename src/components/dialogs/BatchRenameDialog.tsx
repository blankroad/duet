import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, PencilLine } from "lucide-react";
import { commands } from "@/types/bindings";
import type {
  EntryRef,
  RenameRule,
  BatchRenamePlan,
  CaseOp,
} from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

export interface BatchRenameDialogProps {
  targets: EntryRef[];
  onClose: () => void;
  onSubmit: (rule: RenameRule) => void;
}

const CASE_OPTS: { value: "" | CaseOp; labelKey: string }[] = [
  { value: "", labelKey: "dialog.batchRename.caseNone" },
  { value: "lower", labelKey: "dialog.batchRename.caseLower" },
  { value: "upper", labelKey: "dialog.batchRename.caseUpper" },
  { value: "title", labelKey: "dialog.batchRename.caseTitle" },
];

const selectCls =
  "h-7 w-full rounded border border-border bg-subtle px-2 text-base focus:border-accent focus:outline-none";
const smallCls =
  "h-6 rounded border border-border bg-subtle px-1 text-meta focus:border-accent focus:outline-none";

/**
 * 다중 선택 일괄 이름변경. 규칙(찾기·바꾸기 / 접두·접미 / 새 이름 / 대소문자 /
 * 순번)을 입력하면 backend `fs_batch_rename_preview` 로 실시간 미리보기 +
 * 충돌 표시. 적용은 단일 undo 그룹(한 번의 Ctrl+Z). 정규식 없음(리터럴).
 */
export function BatchRenameDialog({
  targets,
  onClose,
  onSubmit,
}: BatchRenameDialogProps) {
  const { t } = useTranslation();
  const [find, setFind] = useState("");
  const findRef = useRef<HTMLInputElement>(null);
  const [replace, setReplace] = useState("");
  const [replaceAll, setReplaceAll] = useState(true);
  const [base, setBase] = useState("");
  const [prefix, setPrefix] = useState("");
  const [suffix, setSuffix] = useState("");
  const [caseOp, setCaseOp] = useState<"" | CaseOp>("");
  const [seqOn, setSeqOn] = useState(false);
  const [seqStart, setSeqStart] = useState(1);
  const [seqPad, setSeqPad] = useState(3);
  const [seqPos, setSeqPos] = useState<"prefix" | "suffix">("suffix");
  const [targetExt, setTargetExt] = useState(false);
  const [plan, setPlan] = useState<BatchRenamePlan | null>(null);

  const rule = useMemo<RenameRule>(
    () => ({
      base: base.trim() === "" ? null : base,
      find,
      replace,
      replace_all: replaceAll,
      prefix,
      suffix,
      seq: seqOn
        ? { start: seqStart, step: 1, padding: seqPad, position: seqPos }
        : null,
      case: caseOp === "" ? null : caseOp,
      target_ext: targetExt,
    }),
    [
      base,
      find,
      replace,
      replaceAll,
      prefix,
      suffix,
      seqOn,
      seqStart,
      seqPad,
      seqPos,
      caseOp,
      targetExt,
    ],
  );

  // 규칙이 바뀌면 디바운스 후 미리보기 요청 (이벤트성 IPC 트리거).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void commands.fsBatchRenamePreview(targets, rule).then((r) => {
        if (alive && r.status === "ok") setPlan(r.data);
      });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [targets, rule]);

  const blocked = !plan || plan.has_collision;
  const changed =
    plan?.items.some((it) => it.old_name !== it.new_name) ?? false;
  const submit = () => {
    if (blocked || !changed) return;
    onSubmit(rule);
  };

  return (
    <DialogShell
      width="xl"
      bodyFill
      title={t("dialog.batchRename.title", { count: targets.length })}
      description={t("dialog.batchRename.desc", { count: targets.length })}
      icon={PencilLine}
      onClose={onClose}
      initialFocus={findRef}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
      }}
      footerLeft={
        plan?.has_collision ? (
          <span className="text-danger">
            {t("dialog.batchRename.collision")}
          </span>
        ) : undefined
      }
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="primary"
            disabled={blocked || !changed}
            onClick={submit}
          >
            {t("dialog.batchRename.cta")}
          </DialogButton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Field label={t("dialog.batchRename.find")}>
          <DialogInput
            ref={findRef}
            mono
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        </Field>
        <Field label={t("dialog.batchRename.replaceWith")}>
          <DialogInput
            mono
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
          />
        </Field>
        <Field label={t("dialog.batchRename.newBase")}>
          <DialogInput
            mono
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder={t("dialog.batchRename.keepOriginal")}
          />
        </Field>
        <Field label={t("dialog.batchRename.case")}>
          <select
            className={selectCls}
            value={caseOp}
            onChange={(e) => setCaseOp(e.target.value as "" | CaseOp)}
          >
            {CASE_OPTS.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.labelKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("dialog.batchRename.prefix")}>
          <DialogInput
            mono
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
          />
        </Field>
        <Field label={t("dialog.batchRename.suffix")}>
          <DialogInput
            mono
            value={suffix}
            onChange={(e) => setSuffix(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-fg-muted">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={replaceAll}
            onChange={(e) => setReplaceAll(e.target.checked)}
          />
          {t("dialog.batchRename.replaceAll")}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={targetExt}
            onChange={(e) => setTargetExt(e.target.checked)}
          />
          {t("dialog.batchRename.includeExt")}
        </label>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={seqOn}
            onChange={(e) => setSeqOn(e.target.checked)}
          />
          {t("dialog.batchRename.number")}
        </label>
        {seqOn && (
          <>
            <span>{t("dialog.batchRename.start")}</span>
            <input
              type="number"
              className={`w-14 ${smallCls}`}
              value={seqStart}
              onChange={(e) => setSeqStart(Number(e.target.value) || 0)}
            />
            <span>{t("dialog.batchRename.pad")}</span>
            <input
              type="number"
              className={`w-12 ${smallCls}`}
              value={seqPad}
              onChange={(e) =>
                setSeqPad(Math.max(0, Number(e.target.value) || 0))
              }
            />
            <select
              className={smallCls}
              value={seqPos}
              onChange={(e) => setSeqPos(e.target.value as "prefix" | "suffix")}
            >
              <option value="suffix">{t("dialog.batchRename.atEnd")}</option>
              <option value="prefix">{t("dialog.batchRename.atStart")}</option>
            </select>
          </>
        )}
      </div>

      {/* 미리보기 */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-panel border border-border">
        <table className="w-full text-meta">
          <tbody>
            {plan?.items.map((it, i) => (
              <tr
                key={`${it.old_name}:${i}`}
                className={
                  it.collision
                    ? "bg-danger/10 text-danger"
                    : "even:bg-subtle/40"
                }
              >
                <td
                  className="truncate px-2 py-0.5 font-mono text-fg-muted"
                  title={it.old_name}
                >
                  {it.old_name}
                </td>
                <td className="px-1 text-fg-muted">→</td>
                <td
                  className="truncate px-2 py-0.5 font-mono"
                  title={it.new_name}
                >
                  {it.collision && (
                    <AlertTriangle size={10} className="mr-1 inline" />
                  )}
                  {it.new_name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DialogShell>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-meta text-fg-muted">{label}</span>
      {children}
    </label>
  );
}
