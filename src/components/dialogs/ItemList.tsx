import { useTranslation } from "react-i18next";
import clsx from "clsx";
import { formatSize } from "@/lib/format";
import { iconForEntry } from "@/lib/fileIcon";
import type { PlanItem } from "@/lib/planItems";

/**
 * 확인 다이얼로그의 대상 목록 — 아이콘 · 이름 · (배지) · 크기.
 *
 * "무엇을" 옮기고 지우는지가 먼저다 — 개수·크기만으로는 잘못된 대상을 그대로
 * 승인하게 된다. 행 모양은 EntryRow 와 같은 어휘(파일 종류 색 아이콘, mono 이름,
 * muted 크기). 긴 목록은 `max` 까지만 보이고 "외 N개".
 */
export function ItemList({
  items,
  badges,
  badgeLabel,
  max = 6,
}: {
  items: PlanItem[];
  /** 배지를 붙일 항목 이름들 (예: 받는 위치에 이미 있는 것). */
  badges?: ReadonlySet<string> | undefined;
  badgeLabel?: string | undefined;
  max?: number;
}) {
  const { t } = useTranslation();
  const shown = items.length > max ? items.slice(0, max) : items;
  const more = items.length - shown.length;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-panel border border-border">
      {shown.map((it) => {
        const { Icon, className } = iconForEntry({
          name: it.name,
          kind: it.kind ?? "file",
        });
        const badge = badges?.has(it.name) ? badgeLabel : undefined;
        return (
          <li
            key={it.name}
            className="flex h-[26px] items-center gap-2 px-2.5"
            title={it.name}
          >
            <Icon size={14} className={clsx("shrink-0", className)} />
            <span className="min-w-0 flex-1 truncate font-mono text-base text-fg">
              {it.name}
            </span>
            {badge && (
              <span className="shrink-0 rounded-[3px] bg-warning/10 px-1.5 py-0.5 text-meta leading-none text-warning">
                {badge}
              </span>
            )}
            <span className="shrink-0 font-mono text-meta tabular-nums text-fg-muted">
              {it.size != null ? formatSize(it.size) : "—"}
            </span>
          </li>
        );
      })}
      {more > 0 && (
        <li className="flex h-6 items-center bg-subtle px-2.5 text-meta text-fg-muted">
          {t("dialog.items.more", { count: more })}
        </li>
      )}
    </ul>
  );
}
