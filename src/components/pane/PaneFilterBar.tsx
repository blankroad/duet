import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search, X } from "lucide-react";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";

/**
 * 패널 빠른 필터 input. PathBar 와 EntryList 사이.
 *
 * - filter 비어있고 unfocused: 컴포넌트 자체 렌더 X (공간 절약)
 * - autoFocus: filterFocused 상태 변경 감지하여 input.focus()
 * - ESC: filter clear + filterFocused=false
 * - Enter: 필터 텍스트를 유지한 채 입력에서 빠져나와 목록 키보드 조작으로 돌아간다
 *   (blur — 입력에 포커스가 남으면 useKeyboardNav 가 방향키를 무시한다)
 */
export function PaneFilterBar({ id }: { id: PaneId }) {
  const { t } = useTranslation();
  const filter = usePanes((s) => activeTab(s, id).filter);
  const filterFocused = usePanes((s) => activeTab(s, id).filterFocused);
  const setFilter = usePanes((s) => s.setFilter);
  const setFilterFocused = usePanes((s) => s.setFilterFocused);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (filterFocused) inputRef.current?.focus();
  }, [filterFocused]);

  if (filter.length === 0 && !filterFocused) return null;

  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-base">
      <Search size={11} className="shrink-0 text-fg-muted" />
      <input
        ref={inputRef}
        type="text"
        value={filter}
        onChange={(e) => setFilter(id, e.target.value)}
        onFocus={() => setFilterFocused(id, true)}
        onBlur={() => setFilterFocused(id, false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setFilter(id, "");
            setFilterFocused(id, false);
          } else if (e.key === "Enter") {
            e.preventDefault();
            setFilterFocused(id, false);
            inputRef.current?.blur();
          }
        }}
        placeholder={t("filter.placeholder")}
        aria-label={t("toolbar.filterName")}
        className="flex-1 bg-transparent font-mono text-base focus:outline-none"
      />
      <button
        type="button"
        onClick={() => {
          setFilter(id, "");
          setFilterFocused(id, false);
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-label={t("filter.clear")}
        title={t("filter.clear")}
      >
        <X size={11} />
      </button>
    </div>
  );
}
