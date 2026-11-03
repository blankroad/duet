import clsx from "clsx";
import { useTranslation } from "react-i18next";
import { useTags, allTagNames } from "@/stores/tags";
import { useTagFilter } from "@/stores/tagFilter";

/**
 * 사이드바 태그 필터 칩바 — 모든 태그를 칩으로. 클릭 토글(OR), 활성 시 Hosts/Bookmarks
 * 를 좁힌다. 태그도 활성 필터도 없으면 렌더 안 함.
 *
 * 켜 둔 태그가 마지막 항목에서 지워져도 칩을 남긴다 — 예전엔 칩과 "지우기"가 함께
 * 사라져, 보이지 않는 필터가 호스트·북마크를 전부 가리고 풀 방법이 없었다.
 */
export function TagBar() {
  const { t: tr } = useTranslation();
  const byKey = useTags((s) => s.byKey);
  const active = useTagFilter((s) => s.active);
  const toggle = useTagFilter((s) => s.toggle);
  const clear = useTagFilter((s) => s.clear);
  const known = allTagNames(byKey);
  const tags = [...known, ...active.filter((a) => !known.includes(a))];

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
            aria-pressed={on}
            title={`#${t}`}
            className={clsx(
              "flex min-h-6 max-w-full items-center rounded-full border px-2 text-meta leading-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
              on
                ? "border-accent bg-accent/15 text-accent"
                : "border-border text-fg-muted hover:bg-border",
            )}
          >
            <span className="truncate">#{t}</span>
          </button>
        );
      })}
      {active.length > 0 && (
        <button
          type="button"
          onClick={clear}
          className="ml-auto flex min-h-6 items-center rounded px-1.5 text-meta text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          {tr("tags.clear")}
        </button>
      )}
    </div>
  );
}
