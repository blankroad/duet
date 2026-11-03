import clsx from "clsx";

/**
 * 패널 도구 모음의 아이콘 버튼. `active` 는 토글 상태(aria-pressed),
 * `shortLabel` 은 폭이 넉넉할 때 아이콘 옆에 보이는 글자 라벨.
 */
interface ToolButtonProps {
  shortLabel?: string;
  alwaysLabel?: boolean;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

export function ToolButton({
  shortLabel,
  alwaysLabel,
  label,
  active,
  disabled,
  onClick,
  children,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-panel px-1.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
        "hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent",
        active ? "text-accent" : "text-fg-muted hover:text-fg",
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
