import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X, AlertTriangle } from "lucide-react";
import { commands } from "@/types/bindings";
import type { EntryRef, RenameRule, BatchRenamePlan, CaseOp } from "@/types/bindings";

export interface BatchRenameDialogProps {
  targets: EntryRef[];
  onClose: () => void;
  onSubmit: (rule: RenameRule) => void;
}

const CASE_OPTS: { value: "" | CaseOp; label: string }[] = [
  { value: "", label: "—" },
  { value: "lower", label: "lower" },
  { value: "upper", label: "UPPER" },
  { value: "title", label: "Title" },
];

/**
 * 다중 선택 일괄 이름변경. 규칙(찾기·바꾸기 / 접두·접미 / 새 이름 / 대소문자 /
 * 순번)을 입력하면 backend `fs_batch_rename_preview` 로 실시간 미리보기 +
 * 충돌 표시. 적용은 단일 undo 그룹(한 번의 Ctrl+Z). 정규식 없음(리터럴).
 */
export function BatchRenameDialog({ targets, onClose, onSubmit }: BatchRenameDialogProps) {
  const [find, setFind] = useState("");
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
      seq: seqOn ? { start: seqStart, step: 1, padding: seqPad, position: seqPos } : null,
      case: caseOp === "" ? null : caseOp,
      target_ext: targetExt,
    }),
    [base, find, replace, replaceAll, prefix, suffix, seqOn, seqStart, seqPad, seqPos, caseOp, targetExt],
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
  const changed = plan?.items.some((it) => it.old_name !== it.new_name) ?? false;
  const submit = () => {
    if (blocked || !changed) return;
    onSubmit(rule);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
            else if (e.key === "Escape") onClose();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
        >
          <div className="mb-3 flex items-start justify-between">
            <Dialog.Title className="text-title font-medium">
              Batch rename — {targets.length} item{targets.length === 1 ? "" : "s"}
            </Dialog.Title>
            <Dialog.Close className="rounded p-1 text-fg-muted hover:bg-border" aria-label="Close">
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-base">
            <Field label="Find">
              <input className={inputCls} value={find} onChange={(e) => setFind(e.target.value)} />
            </Field>
            <Field label="Replace with">
              <input className={inputCls} value={replace} onChange={(e) => setReplace(e.target.value)} />
            </Field>
            <Field label="New base (replace name)">
              <input className={inputCls} value={base} onChange={(e) => setBase(e.target.value)} placeholder="(keep original)" />
            </Field>
            <Field label="Case">
              <select className={inputCls} value={caseOp} onChange={(e) => setCaseOp(e.target.value as "" | CaseOp)}>
                {CASE_OPTS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Prefix">
              <input className={inputCls} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
            </Field>
            <Field label="Suffix">
              <input className={inputCls} value={suffix} onChange={(e) => setSuffix(e.target.value)} />
            </Field>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-fg-muted">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={replaceAll} onChange={(e) => setReplaceAll(e.target.checked)} />
              replace all
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={targetExt} onChange={(e) => setTargetExt(e.target.checked)} />
              include extension
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={seqOn} onChange={(e) => setSeqOn(e.target.checked)} />
              number
            </label>
            {seqOn && (
              <>
                <span>start</span>
                <input
                  type="number"
                  className="w-14 rounded border border-border bg-subtle px-1 py-0.5"
                  value={seqStart}
                  onChange={(e) => setSeqStart(Number(e.target.value) || 0)}
                />
                <span>pad</span>
                <input
                  type="number"
                  className="w-12 rounded border border-border bg-subtle px-1 py-0.5"
                  value={seqPad}
                  onChange={(e) => setSeqPad(Math.max(0, Number(e.target.value) || 0))}
                />
                <select
                  className="rounded border border-border bg-subtle px-1 py-0.5"
                  value={seqPos}
                  onChange={(e) => setSeqPos(e.target.value as "prefix" | "suffix")}
                >
                  <option value="suffix">at end</option>
                  <option value="prefix">at start</option>
                </select>
              </>
            )}
          </div>

          {/* 미리보기 */}
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto rounded border border-border">
            <table className="w-full text-meta">
              <tbody>
                {plan?.items.map((it, i) => (
                  <tr
                    key={`${it.old_name}:${i}`}
                    className={it.collision ? "bg-danger/10 text-danger" : "even:bg-subtle/40"}
                  >
                    <td className="truncate px-2 py-0.5 font-mono text-fg-muted">{it.old_name}</td>
                    <td className="px-1 text-fg-muted">→</td>
                    <td className="truncate px-2 py-0.5 font-mono">
                      {it.collision && <AlertTriangle size={10} className="mr-1 inline" />}
                      {it.new_name}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <span className="text-meta text-danger">
              {plan?.has_collision ? "Name collisions — resolve before applying." : ""}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={blocked || !changed}
                className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
              >
                Rename
              </button>
            </div>
          </div>
          <Dialog.Description className="sr-only">
            Rename {targets.length} item(s) using a shared rule with live preview.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const inputCls =
  "w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-meta text-fg-muted">{label}</span>
      {children}
    </label>
  );
}
