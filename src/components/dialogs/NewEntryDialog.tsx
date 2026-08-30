import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus2, FolderPlus } from "lucide-react";
import type { Location } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

export interface NewEntryDialogProps {
  /** 만들 대상 — 제목/플레이스홀더만 갈리고 나머지 UI 는 동일. */
  kind: "dir" | "file";
  parent: Location;
  onClose: () => void;
  onSubmit: (name: string) => void;
}

/** 활성 폴더에 새 폴더 / 새 빈 파일을 만드는 이름 입력 다이얼로그. */
export function NewEntryDialog({
  kind,
  parent,
  onClose,
  onSubmit,
}: NewEntryDialogProps) {
  const { t } = useTranslation();
  // i18n 키 묶음만 교체 — 두 묶음의 하위 키(title/in/placeholder/create/desc) 동일.
  const k = kind === "dir" ? "mkdir" : "newFile";
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <DialogShell
      width="sm"
      title={t(`dialog.${k}.title`)}
      subtitle={
        <span title={parent.path}>
          {t(`dialog.${k}.in`, { path: parent.path })}
        </span>
      }
      description={t(`dialog.${k}.desc`, { path: parent.path })}
      icon={kind === "dir" ? FolderPlus : FilePlus2}
      onClose={onClose}
      initialFocus={inputRef}
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
            {t(`dialog.${k}.create`)}
          </DialogButton>
        </>
      }
    >
      <DialogInput
        ref={inputRef}
        mono
        type="text"
        value={name}
        placeholder={t(`dialog.${k}.placeholder`)}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
    </DialogShell>
  );
}
