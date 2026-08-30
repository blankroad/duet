import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Terminal, Trash2 } from "lucide-react";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

export interface ArgsDialogProps {
  /** 편집 대상 앱 이름 (표시용). */
  name: string;
  /** 현재 인자 목록. */
  initial: string[];
  onClose: () => void;
  onSubmit: (args: string[]) => void;
}

/**
 * 앱 실행 인자 편집 — 같은 앱을 다른 인자로 다른 동작. 행당 인자 1개(argv 배열이
 * 진실의 원천 — 셸 문자열 재분할 안 함, 인용 버그 회피).
 */
export function ArgsDialog({
  name,
  initial,
  onClose,
  onSubmit,
}: ArgsDialogProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<string[]>(
    initial.length > 0 ? initial : [""],
  );

  const setRow = (i: number, v: string) =>
    setRows((r) => r.map((x, j) => (j === i ? v : x)));
  const addRow = () => setRows((r) => [...r, ""]);
  const removeRow = (i: number) =>
    setRows((r) => (r.length <= 1 ? [""] : r.filter((_, j) => j !== i)));
  const submit = () =>
    onSubmit(rows.map((r) => r.trim()).filter((r) => r.length > 0));

  return (
    <DialogShell
      title={t("dialog.args.title", { name })}
      description={t("dialog.args.desc", { name })}
      icon={Terminal}
      onClose={onClose}
      footerLeft={t("dialog.args.note")}
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton tone="primary" hint="enter" onClick={submit}>
            {t("dialog.args.save")}
          </DialogButton>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-1">
            <span className="w-5 text-right text-meta text-fg-muted">
              {i + 1}
            </span>
            <DialogInput
              mono
              type="text"
              value={r}
              placeholder={t("dialog.args.placeholder")}
              autoFocus={i === rows.length - 1}
              onChange={(e) => setRow(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              className="rounded p-1 text-fg-muted hover:bg-border hover:text-danger"
              aria-label={t("dialog.args.remove")}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-meta text-fg-muted hover:text-fg"
      >
        <Plus size={12} /> {t("dialog.args.add")}
      </button>
    </DialogShell>
  );
}
