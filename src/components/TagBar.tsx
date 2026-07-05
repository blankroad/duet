import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useTags, allTagNames } from "@/stores/tags";
import { useTagFilter } from "@/stores/tagFilter";

/**
 * 사이드바 태그 필터 칩바 — 모든 태그를 칩으로. 클릭 토글(OR), 활성 시 Hosts/Bookmarks
 * 를 좁힌다. 태그가 하나도 없으면 렌더 안 함.
 */
export function TagBar() {
  const { t: tr } = useTranslation();
  const byKey = useTags((s) => s.byKey);
  const active = useTagFilter((s) => s.active);
  const toggle = useTagFilter((s) => s.toggle);
  const clear = useTagFilter((s) => s.clear);
  const tags = allTagNames(byKey);

  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
      {tags.map((t) => {
        const on = active.includes(t);
        return (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            className={clsx(
              "rounded-full border px-1.5 py-0.5 text-meta leading-none",
              on
                ? "border-accent bg-accent/15 text-accent"
                : "border-border text-fg-muted hover:bg-border",
            )}
          >
            #{t}
          </button>
        );
      })}
      {active.length > 0 && (
        <button
          type="button"
          onClick={clear}
          className="ml-auto text-meta text-fg-muted hover:text-fg"
        >
          {tr("tags.clear")}
        </button>
      )}
    </div>
  );
}
