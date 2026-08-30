import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";

export type DialogIconTone = "muted" | "accent" | "danger";
export type DialogWidth = "sm" | "md" | "lg" | "xl" | "2xl";

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
  /** 헤더 오른쪽 슬롯 — 알고리즘 선택, 상태 배지 같은 작은 컨트롤. */
  headerRight?: ReactNode | undefined;
  /**
   * sm=384 (짧은 입력) · md=480 (확인/충돌/진행률) · lg=512 (목록) ·
   * xl=672 (편집 작업창) · 2xl=768 (비교/치트시트).
   */
  width?: DialogWidth | undefined;
  /** tall = 높이 고정(32rem) — 설정처럼 섹션 전환 시 창이 출렁이면 안 되는 것. */
  height?: "auto" | "tall" | undefined;
  /** false 면 본문 패딩·간격 없음 (사이드바 레이아웃 등 본문이 직접 그릴 때). */
  bodyPadding?: boolean | undefined;
  /** true 면 본문이 남는 높이를 채움 — 안쪽 목록이 스크롤하는 작업창용. */
  bodyFill?: boolean | undefined;
  /** 헤더/푸터와 본문 사이 구분선 — 본문이 스크롤하는 작업창에서 경계를 잡아준다. */
  divided?: boolean | undefined;
  children: ReactNode;
  /** 푸터 왼쪽 — 선택 집계 등. 버튼 반대편에 작은 글씨. */
  footerLeft?: ReactNode | undefined;
  /** 푸터 버튼들. footerLeft 도 없으면 푸터 행 자체를 생략. */
  footer?: ReactNode | undefined;
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
  /** 다이얼로그 전체 키 핸들러 (Ctrl+Enter 제출 등). Esc 는 Radix 가 처리. */
  onKeyDown?: ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined;
}

const ICON_TONE: Record<DialogIconTone, string> = {
  muted: "bg-subtle text-fg-muted",
  accent: "bg-accent/10 text-accent",
  danger: "bg-danger/10 text-danger",
};

const WIDTH: Record<DialogWidth, string> = {
  sm: "max-w-sm",
  md: "max-w-[30rem]",
  lg: "max-w-lg",
  xl: "max-w-2xl",
  "2xl": "max-w-3xl",
};

/**
 * 모달 공통 셸 — 헤더(아이콘 타일 + 제목 + 요약) / 본문 / 푸터(왼쪽 집계, 오른쪽 버튼).
 *
 * 헤더 X 는 두지 않는다: Esc 와 [취소]/[닫기] 가 같은 일을 하므로 (DialogButton
 * 힌트로 노출). 폭은 다섯 단계로 고정해 다이얼로그마다 제멋대로 달라지지 않게 한다.
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
  headerRight,
  width = "md",
  height = "auto",
  bodyPadding = true,
  bodyFill = false,
  divided = false,
  children,
  footerLeft,
  footer,
  onClose,
  initialFocus,
  selectOnFocus = false,
  layer = "base",
  dismissOnOutsideClick = true,
  onKeyDown,
}: DialogShellProps) {
  const z = layer === "above" ? "z-[60]" : "z-50";
  const hasFooter = footer != null || footerLeft != null;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className={clsx("fixed inset-0 bg-black/50", z)} />
        <Dialog.Content
          onKeyDown={onKeyDown}
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
            WIDTH[width],
            height === "tall" && "h-[32rem]",
          )}
        >
          <div
            className={clsx(
              "flex items-start gap-2.5 px-4 pt-3.5",
              divided && "border-b border-border pb-3",
            )}
          >
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
            {headerRight && (
              <div className="flex shrink-0 items-center gap-2">
                {headerRight}
              </div>
            )}
          </div>

          <div
            className={clsx(
              "flex min-h-0 flex-col overflow-auto text-base",
              bodyPadding && "gap-2.5 px-4 pt-3.5",
              bodyPadding && !hasFooter && "pb-4",
              bodyFill && "flex-1",
            )}
          >
            {children}
          </div>

          {hasFooter && (
            <div
              className={clsx(
                "flex items-center gap-2 p-4",
                divided && "border-t border-border pt-3",
              )}
            >
              <div className="min-w-0 flex-1 truncate text-meta text-fg-muted">
                {footerLeft}
              </div>
              {footer}
            </div>
          )}

          <Dialog.Description className="sr-only">
            {description ?? title}
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
