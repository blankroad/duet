import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";

export interface ConfirmDialogProps {
  title: string;
  /** 제목 아래 요약 (개수·용량·위치). */
  subtitle?: ReactNode | undefined;
  icon?: LucideIcon | undefined;
  body: ReactNode;
  ctaLabel: string;
  ctaTone: "neutral" | "danger";
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 확인 다이얼로그 — 휴지통 삭제, repack, 꺼내기, 권한 상승 등.
 * 주 버튼에 포커스(Enter = 확인), Esc/바깥 클릭 = 취소.
 */
export function ConfirmDialog({
  title,
  subtitle,
  icon,
  body,
  ctaLabel,
  ctaTone,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const ctaRef = useRef<HTMLButtonElement>(null);
  const danger = ctaTone === "danger";
  return (
    <DialogShell
      title={title}
      subtitle={subtitle}
      icon={icon}
      iconTone={danger ? "danger" : "muted"}
      onClose={onCancel}
      initialFocus={ctaRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={onCancel}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            ref={ctaRef}
            tone={danger ? "danger" : "primary"}
            hint="enter"
            onClick={onConfirm}
          >
            {ctaLabel}
          </DialogButton>
        </>
      }
    >
      {body}
    </DialogShell>
  );
}
