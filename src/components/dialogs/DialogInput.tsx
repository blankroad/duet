import { forwardRef } from "react";
import clsx from "clsx";
import type { InputHTMLAttributes } from "react";

interface DialogInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 파일명·경로·암호처럼 글자 하나하나가 중요한 값은 mono. */
  mono?: boolean | undefined;
  /** 포커스 테두리 색 — 위험 확인(영구 삭제)은 danger. */
  tone?: "accent" | "danger" | undefined;
}

/**
 * 다이얼로그 공통 텍스트 입력 — 28px, bg-subtle, 포커스 시 accent 테두리.
 * 다이얼로그마다 같은 클래스 문자열이 복제되던 것을 한 곳으로.
 */
export const DialogInput = forwardRef<HTMLInputElement, DialogInputProps>(
  function DialogInput({ mono, tone = "accent", className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        spellCheck={false}
        {...rest}
        className={clsx(
          "h-7 w-full rounded border border-border bg-subtle px-2 text-base text-fg placeholder:text-fg-muted/50 focus:outline-none",
          tone === "danger" ? "focus:border-danger" : "focus:border-accent",
          mono && "font-mono",
          className,
        )}
      />
    );
  },
);
