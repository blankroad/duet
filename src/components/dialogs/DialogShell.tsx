import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";

export type DialogIconTone = "muted" | "accent" | "danger";

interface DialogShellProps {
  /** 제어형 열림 — 생략 시 항상 열림(마운트 = 열림). */
  open?: boolean | undefined;
  title: string;
  /** 제목 아래 한 줄 요약 — 개수·용량·위치 같은 보조 정보. */
  subtitle?: ReactNode | undefined;
  /** 스크린리더용 설명. 생략 시 title. */
  description?: string | undefined;
  /** 헤더 아이콘 타일. 생략 시 타일 없음. */
  icon?: LucideIcon | undefined;
  iconTone?: DialogIconTone | undefined;
  iconClassName?: string | undefined;
  titleTone?: "fg" | "danger" | undefined;
  /** sm=384px (짧은 입력), md=480px (확인/충돌/진행률). */
  width?: "sm" | "md" | undefined;
  children: ReactNode;
  /** 푸터 왼쪽 — 선택 집계 등. 버튼 반대편에 작은 글씨. */
  footerLeft?: ReactNode | undefined;
  footer: ReactNode;
  /** Esc / 바깥 클릭 / Radix 닫힘 — 취소와 동일 경로. */
  onClose: () => void;
  /** 열릴 때 포커스할 요소 (기본: Radix 첫 포커스 가능 요소). */
  initialFocus?: RefObject<HTMLElement | null> | undefined;
  /** initialFocus 가 input 이면 내용 전체 선택 (초기값 덮어쓰기용). */
  selectOnFocus?: boolean | undefined;
  /** above = 다른 다이얼로그 위에 겹쳐 뜨는 것 (암호 프롬프트 등, z-60). */
  layer?: "base" | "above" | undefined;
  /** false 면 바깥 클릭으로 닫히지 않음 (진행률처럼 실수로 놓치면 안 되는 것). */
  dismissOnOutsideClick?: boolean | undefined;
}

const ICON_TONE: Record<DialogIconTone, string> = {
  muted: "bg-subtle text-fg-muted",
  accent: "bg-accent/10 text-accent",
  danger: "bg-danger/10 text-danger",
};

/**
 * 모달 공통 셸 — 헤더(아이콘 타일 + 제목 + 요약) / 본문 / 푸터(왼쪽 집계, 오른쪽 버튼).
 *
 * 헤더 X 는 두지 않는다: Esc 와 [취소] 가 같은 일을 하므로 (DialogButton 힌트로 노출).
 * 폭은 sm/md 두 가지로 고정해 다이얼로그마다 384/448/512 가 섞이지 않게 한다.
 * 색·모양은 전부 테마 토큰(bg-base, border, rounded-panel, shadow-raised).
 */
export function DialogShell({
  open = true,
  title,
  subtitle,
  description,
  icon: Icon,
  iconTone = "muted",
  iconClassName,
  titleTone = "fg",
  width = "md",
  children,
  footerLeft,
  footer,
  onClose,
  initialFocus,
  selectOnFocus = false,
  layer = "base",
  dismissOnOutsideClick = true,
}: DialogShellProps) {
  const z = layer === "above" ? "z-[60]" : "z-50";
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={clsx("fixed inset-0 bg-black/50", z)} />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            if (!initialFocus) return;
            e.preventDefault();
            const el = initialFocus.current;
            el?.focus();
            if (selectOnFocus && el instanceof HTMLInputElement) el.select();
          }}
          onPointerDownOutside={(e) => {
            if (!dismissOnOutsideClick) e.preventDefault();
          }}
          className={clsx(
            "fixed left-1/2 top-1/2 flex max-h-[85vh] w-full -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border border-border bg-base shadow-raised focus:outline-none",
            z,
            width === "sm" ? "max-w-sm" : "max-w-[30rem]",
          )}
        >
          <div className="flex items-start gap-2.5 px-4 pt-3.5">
            {Icon && (
              <div
                className={clsx(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-panel",
                  ICON_TONE[iconTone],
                )}
              >
                <Icon size={15} className={iconClassName} />
              </div>
            )}
            <div className="flex min-w-0 flex-1 flex-col">
              <Dialog.Title
                className={clsx(
                  "text-title",
                  titleTone === "danger" ? "text-danger" : "text-fg",
                )}
              >
                {title}
              </Dialog.Title>
              {subtitle && (
                <div className="truncate text-meta text-fg-muted">
                  {subtitle}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-2.5 overflow-auto px-4 pt-3.5 text-base">
            {children}
          </div>

          <div className="flex items-center gap-2 p-4">
            <div className="min-w-0 flex-1 truncate text-meta text-fg-muted">
              {footerLeft}
            </div>
            {footer}
          </div>

          <Dialog.Description className="sr-only">
            {description ?? title}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
