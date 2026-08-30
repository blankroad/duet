import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileArchive } from "lucide-react";
import type { CompressFormat } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";
import { Segmented } from "./Segmented";

export interface CompressDialogProps {
  /** 압축 대상 항목 수 (본문 표시용). */
  itemCount: number;
  /** 기본 아카이브 이름 (확장자 제외). */
  defaultName: string;
  onClose: () => void;
  onSubmit: (name: string, format: CompressFormat) => void;
}

const FORMATS: { value: CompressFormat; label: string }[] = [
  { value: "zip", label: ".zip" },
  { value: "tar_gz", label: ".tar.gz" },
];

/** 선택 항목을 아카이브로 — 이름(전체 선택된 채 열림) + 포맷. */
export function CompressDialog({
  itemCount,
  defaultName,
  onClose,
  onSubmit,
}: CompressDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [format, setFormat] = useState<CompressFormat>("zip");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed, format);
  };

  return (
    <DialogShell
      width="sm"
      title={t("dialog.compress.title")}
      subtitle={t("dialog.compress.items", { count: itemCount })}
      description={t("dialog.compress.desc", { count: itemCount })}
      icon={FileArchive}
      onClose={onClose}
      initialFocus={inputRef}
      selectOnFocus
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="primary"
            hint="enter"
            disabled={!name.trim()}
            onClick={submit}
          >
            {t("dialog.compress.cta")}
          </DialogButton>
        </>
      }
    >
      <div className="flex items-center gap-2">
        <DialogInput
          ref={inputRef}
          mono
          type="text"
          value={name}
          placeholder={t("dialog.compress.placeholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <Segmented
          value={format}
          options={FORMATS}
          onChange={setFormat}
          className="font-mono"
        />
      </div>
    </DialogShell>
  );
}
