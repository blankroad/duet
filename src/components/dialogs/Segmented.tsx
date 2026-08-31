import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

export type SegmentedSize = "sm" | "md" | "lg";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** lg 에서만 그린다 — 좁은 행(md/sm)에서는 라벨을 위해 자리를 양보. */
  icon?: LucideIcon | undefined;
  /** 선택됐을 때 accent 대신 danger 로 채움 (교체 같은 파괴적 선택). */
  danger?: boolean | undefined;
}

const SIZE: Record<SegmentedSize, { box: string; cell: string; icon: number }> =
  {
    sm: { box: "h-[22px] text-meta", cell: "px-2 gap-1", icon: 11 },
    md: { box: "h-[26px] text-meta", cell: "px-2 gap-1.5", icon: 12 },
    lg: { box: "h-8 text-[12px]", cell: "px-2.5 gap-1.5", icon: 13 },
  };

/**
 * 세그먼트 선택 — 충돌 정책(건너뛰기 / 둘 다 유지 / 교체) 같은 소수 상호배타 옵션.
 *
 * 고르지 않은 칸도 `bg-base` 로 채우고 칸 사이 1px 을 컨테이너 배경(border 색)으로
 * 드러낸다 — 예전엔 선택된 칸만 색이 있고 나머지는 투명이라 "세 칸"으로 보이지 않았다.
 * 선택 칸은 accent(파괴적이면 danger) 로 채운다.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = "sm",
  fill = false,
  className,
}: {
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  size?: SegmentedSize | undefined;
  /** 남는 가로를 채우고 칸을 균등 분할 (일괄 선택처럼 주 컨트롤일 때). */
  fill?: boolean | undefined;
  className?: string | undefined;
}) {
  const s = SIZE[size];
  return (
    <div
      role="radiogroup"
      className={clsx(
        "shrink-0 gap-px overflow-hidden rounded border border-border bg-border",
        fill ? "flex w-full" : "inline-flex",
        s.box,
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        const Icon = size === "lg" ? o.icon : undefined;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={clsx(
              "flex items-center justify-center whitespace-nowrap transition-colors",
              fill && "flex-1",
              s.cell,
              on
                ? o.danger
                  ? "bg-danger text-white"
                  : "bg-accent text-white"
                : "bg-base text-fg-muted hover:bg-subtle hover:text-fg",
            )}
          >
            {Icon && <Icon size={s.icon} aria-hidden />}
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
