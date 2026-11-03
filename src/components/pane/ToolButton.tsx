import clsx from "clsx";

/**
 * 패널 도구 모음의 아이콘 버튼. `active` 는 토글 상태(aria-pressed),
 * `shortLabel` 은 폭이 넉넉할 때 아이콘 옆에 보이는 글자 라벨.
 */
interface ToolButtonProps {
  shortLabel?: string;
  alwaysLabel?: boolean;
  /** 툴팁(title). 상태 문구와 키 힌트를 담을 수 있다. */
  label: string;
  /** 접근 이름 — 토글은 상태와 무관하게 고정하고 상태는 aria-pressed 로만 전한다. */
  ariaLabel?: string;
  /** 반응형 표시용 클래스 (globals.css 컨테이너 쿼리). */
  className?: string;
  active?: boolean;
  disabled?: boolean;
  /** 메뉴를 여는 버튼이면 true (aria-haspopup). */
  menu?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}

export function ToolButton({
  shortLabel,
  alwaysLabel,
  label,
  ariaLabel,
  className,
  active,
  disabled,
  menu,
  onClick,
  children,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={ariaLabel ?? label}
      aria-pressed={active}
      aria-haspopup={menu ? "menu" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-panel px-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
        "disabled:opacity-30 disabled:hover:bg-transparent",
        // 켜짐은 색만이 아니라 배경 채움으로도 구분 (라이트 모드 가시성).
        active
          ? "bg-active text-accent"
          : "text-fg-muted hover:bg-subtle hover:text-fg",
        className,
      )}
    >
      {children}
      {shortLabel && (
        <span
          className={
            alwaysLabel ? "toolbar-create-label" : "toolbar-action-label"
          }
        >
          {shortLabel}
        </span>
      )}
    </button>
  );
}
