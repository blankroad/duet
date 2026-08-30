import { Search } from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
import type { CompareStatus } from "@/types/bindings";
import { ALL_STATUSES, statusLabel, TONE, ICON } from "./compareView";

/**
 * 비교 필터 바 — 상태별 카운트 칩(클릭 토글, 0개는 숨김) + 경로 검색.
 */
export function CompareFilterBar({
  counts,
  active,
  toggle,
  query,
  setQuery,
}: {
  counts: Record<CompareStatus, number>;
  active: Set<CompareStatus>;
  toggle: (s: CompareStatus) => void;
  query: string;
  setQuery: (q: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {ALL_STATUSES.filter((s) => counts[s] > 0).map((s) => {
        const on = active.has(s);
        const Icon = ICON[s];
        const label = statusLabel(s, t);
        return (
          <button
            key={s}
            type="button"
            onClick={() => toggle(s)}
            aria-pressed={on}
            className={clsx(
              "flex items-center gap-1 rounded border px-1.5 py-0.5 text-meta",
              on
                ? "border-border bg-subtle"
                : "border-transparent text-fg-muted opacity-60",
            )}
            title={t("dialog.compare.toggleStatus", { label })}
          >
            <Icon size={11} className={TONE[s]} />
            <span>{label}</span>
            <b className="text-fg">{counts[s]}</b>
          </button>
        );
      })}
      <div className="ml-auto flex items-center gap-1 rounded border border-border bg-subtle px-1.5">
        <Search size={11} className="text-fg-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("dialog.compare.searchPlaceholder")}
          className="w-32 bg-transparent py-0.5 text-meta focus:outline-none"
        />
      </div>
    </div>
  );
}
