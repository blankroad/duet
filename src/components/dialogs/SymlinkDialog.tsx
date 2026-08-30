import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "lucide-react";
import type { Location } from "@/types/bindings";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";
import { DialogInput } from "./DialogInput";

export interface SymlinkDialogProps {
  parent: Location;
  onClose: () => void;
  onSubmit: (name: string, target: string) => void;
}

/**
 * 심볼릭 링크 생성 — 링크 이름 + 대상 경로(상대/절대 그대로, 존재 검증 안 함 —
 * 의도적 dangling 링크 허용). undo 는 링크 제거.
 */
export function SymlinkDialog({
  parent,
  onClose,
  onSubmit,
}: SymlinkDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const path = String(parent.path);

  const canSubmit = name.trim() !== "" && target.trim() !== "";
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(name.trim(), target.trim());
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <DialogShell
      width="sm"
      title={t("dialog.symlink.title")}
      subtitle={<span title={path}>{t("dialog.symlink.in", { path })}</span>}
      description={t("dialog.symlink.desc", { path })}
      icon={Link}
      onClose={onClose}
      initialFocus={nameRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={onClose}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="primary"
            hint="enter"
            disabled={!canSubmit}
            onClick={submit}
          >
            {t("dialog.symlink.create")}
          </DialogButton>
        </>
      }
    >
      <DialogInput
        ref={nameRef}
        mono
        type="text"
        value={name}
        placeholder={t("dialog.symlink.namePlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onEnter}
      />
      <DialogInput
        mono
        type="text"
        value={target}
        placeholder={t("dialog.symlink.targetPlaceholder")}
        onChange={(e) => setTarget(e.target.value)}
        onKeyDown={onEnter}
      />
    </DialogShell>
  );
}
