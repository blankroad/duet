import { useRef, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { DialogShell } from "./DialogShell";
import { DialogButton } from "./DialogButton";

export interface DangerConfirmDialogProps {
  title: string;
  subtitle?: ReactNode | undefined;
  /** 경고 밴드 한 줄 — 왜 되돌릴 수 없는지. */
  warning: string;
  /** 대상 목록 등 추가 본문. */
  body?: ReactNode | undefined;
  requiredWord: string;
  /** 주 버튼 라벨. 기본 "삭제". */
  ctaLabel?: string | undefined;
  onCancel: () => void;
  /** 사용자가 실제로 타이핑한 확인 단어를 전달 — 백엔드 검증용(§3). */
  onConfirm: (typedWord: string) => void;
}

/**
 * 위험 확인 다이얼로그 (영구 삭제) — 단어 타이핑 전까지 주 버튼 비활성.
 * DESIGN.md "위험 확인 다이얼로그": 빨간 제목·빨간 버튼·단어 강제.
 * 테두리 전체를 빨갛게 칠하는 대신 아이콘 타일 + 경고 밴드로 위험을 표시한다.
 */
export function DangerConfirmDialog({
  title,
  subtitle,
  warning,
  body,
  requiredWord,
  ctaLabel,
  onCancel,
  onConfirm,
}: DangerConfirmDialogProps) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const enabled = typed === requiredWord;

  return (
    <DialogShell
      title={title}
      subtitle={subtitle}
      icon={AlertTriangle}
      iconTone="danger"
      titleTone="danger"
      onClose={onCancel}
      initialFocus={inputRef}
      footer={
        <>
          <DialogButton hint="esc" onClick={onCancel}>
            {t("common.cancel")}
          </DialogButton>
          <DialogButton
            tone="danger"
            hint="enter"
            disabled={!enabled}
            onClick={() => onConfirm(typed)}
          >
            {ctaLabel ?? t("common.delete")}
          </DialogButton>
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-panel border border-danger/30 bg-danger/10 px-3 py-2.5 text-base text-fg">
        <AlertTriangle size={14} className="shrink-0 text-danger" />
        <span>{warning}</span>
      </div>
      {body}
      <div className="flex flex-col gap-1">
        <div className="text-meta text-fg-muted">
          <Trans
            i18nKey="common.typeToConfirm"
            values={{ word: requiredWord }}
            components={{
              // {{word}} 를 kbd 칩으로 감싸기 위한 Trans 사용.
              1: (
                <kbd className="rounded-[3px] border border-border bg-subtle px-1 font-mono text-fg" />
              ),
            }}
          />
        </div>
        <input
          ref={inputRef}
          type="text"
          value={typed}
          placeholder={requiredWord}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && enabled) onConfirm(typed);
          }}
          className="h-7 w-full rounded border border-border bg-subtle px-2 font-mono text-base placeholder:text-fg-muted/50 focus:border-danger focus:outline-none"
        />
      </div>
    </DialogShell>
  );
}
