import { forwardRef } from "react";
import clsx from "clsx";
import type { ReactNode } from "react";

export type DialogButtonTone = "secondary" | "primary" | "danger";

interface DialogButtonProps {
  tone?: DialogButtonTone | undefined;
  /** 키보드 힌트 — 버튼 안 작은 kbd 칩. enter=↵, esc=Esc. */
  hint?: "enter" | "esc" | undefined;
  /** secondary 톤에서 글자만 danger 색 (진행률 취소 등 — 배경은 채우지 않음). */
  dangerText?: boolean | undefined;
  disabled?: boolean | undefined;
  onClick: () => void;
  children: ReactNode;
}

/**
 * 다이얼로그 푸터 버튼 — 28px, 앱 공통 버튼 모양(px-3 py-1 text-base)에 키 힌트 추가.
 * DESIGN.md "키보드 1급": 어떤 키가 무엇을 하는지 버튼에서 바로 보이게.
 */
export const DialogButton = forwardRef<HTMLButtonElement, DialogButtonProps>(
  function DialogButton(
    { tone = "secondary", hint, dangerText, disabled, onClick, children },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={clsx(
          "inline-flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded px-3 text-base leading-none transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          "disabled:opacity-30",
          tone === "primary" && "bg-accent text-white",
          tone === "danger" && "bg-danger text-white",
          tone === "secondary" && [
            "border border-border hover:bg-subtle",
            dangerText ? "text-danger" : "text-fg",
          ],
        )}
      >
        <span>{children}</span>
        {hint && (
          <kbd className="rounded-[3px] border border-current px-1 py-0.5 font-mono text-[10px] leading-none opacity-50">
            {hint === "enter" ? "↵" : "Esc"}
          </kbd>
        )}
      </button>
    );
  },
);
