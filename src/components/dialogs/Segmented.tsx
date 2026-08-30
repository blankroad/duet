import clsx from "clsx";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** 선택됐을 때 accent 대신 danger 로 채움 (교체 같은 파괴적 선택). */
  danger?: boolean | undefined;
}

/**
 * 세그먼트 선택 — 충돌 정책(건너뛰기 / 둘 다 유지 / 교체) 같은 소수 상호배타 옵션.
 * 22px, text-meta. 선택 항목은 accent(파괴적이면 danger) 로 채운다.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  className?: string | undefined;
}) {
  return (
    <div
      className={clsx(
        "inline-flex h-[22px] shrink-0 overflow-hidden rounded border border-border text-meta",
        className,
      )}
      role="radiogroup"
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={clsx(
              "px-2 transition-colors",
              i > 0 && "border-l border-border",
              on
                ? o.danger
                  ? "bg-danger text-white"
                  : "bg-accent text-white"
                : "text-fg-muted hover:bg-subtle hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
