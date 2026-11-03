import { ArrowDownWideNarrow, ArrowUpNarrowWide, Check } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import {
  usePanes,
  activeTab,
  defaultOrderFor,
  type PaneId,
  type SortKey,
} from "@/stores/panes";
import { ToolButton } from "./ToolButton";

const SORT_KEYS: { key: SortKey; label: string; commandId: string }[] = [
  { key: "name", label: "menu.sortName", commandId: "sort.byName" },
  { key: "size", label: "menu.sortSize", commandId: "sort.bySize" },
  { key: "mtime", label: "menu.sortMtime", commandId: "sort.byMtime" },
  { key: "kind", label: "menu.sortKind", commandId: "sort.byKind" },
  { key: "ext", label: "menu.sortExt", commandId: "sort.byExt" },
];

function sortLabel(t: TFunction, key: SortKey): string {
  return t(SORT_KEYS.find((k) => k.key === key)?.label ?? "menu.sortName");
}

const mark = (on: boolean) =>
  on ? <Check size={14} /> : <span className="w-3.5" />;

/**
 * 정렬 메뉴 항목 — 기준(현재 체크) + 방향(현재 체크).
 * 다른 기준을 고르면 그 기준의 기본 방향, 같은 기준이면 방향 유지.
 * 툴바 정렬 버튼과 좁은 폭의 `보기` 메뉴가 같이 쓴다.
 */
export function sortMenuEntries(id: PaneId, t: TFunction): MenuEntry[] {
  const tab = activeTab(usePanes.getState(), id);
  const apply = (key: SortKey, order = tab.sortOrder) => {
    const s = usePanes.getState();
    s.setActivePane(id);
    s.setSort(id, key, order);
  };
  return [
    ...SORT_KEYS.map(({ key, label, commandId }) => ({
      id: `sort-${key}`,
      label: t(label),
      commandId,
      icon: mark(tab.sortKey === key),
      onSelect: () =>
        apply(key, key === tab.sortKey ? tab.sortOrder : defaultOrderFor(key)),
    })),
    { kind: "separator" },
    {
      id: "sort-asc",
      label: t("toolbar.sortAsc"),
      icon: mark(tab.sortOrder === "asc"),
      onSelect: () => apply(tab.sortKey, "asc"),
    },
    {
      id: "sort-desc",
      label: t("toolbar.sortDesc"),
      icon: mark(tab.sortOrder === "desc"),
      onSelect: () => apply(tab.sortKey, "desc"),
    },
  ];
}

/**
 * 툴바 정렬 버튼 — 그리드/타일처럼 열 머리글이 없는 보기에서도 현재 정렬
 * 기준·방향을 보여 주고, 클릭 한 번으로 정렬 메뉴를 연다.
 */
/** 현재 정렬 요약 ("정렬: 수정일 · 내림차순") — 정렬 버튼이 접힌 좁은 폭의 `보기` 툴팁에도 쓴다. */
export function useSortSummary(id: PaneId): {
  summary: string;
  keyLabel: string;
  sortOrder: "asc" | "desc";
} {
  const { t } = useTranslation();
  const sortKey = usePanes((s) => activeTab(s, id).sortKey);
  const sortOrder = usePanes((s) => activeTab(s, id).sortOrder);
  const keyLabel = sortLabel(t, sortKey);
  const order = t(sortOrder === "asc" ? "toolbar.sortAsc" : "toolbar.sortDesc");
  return {
    summary: t("toolbar.sortTitle", { key: keyLabel, order }),
    keyLabel,
    sortOrder,
  };
}

export function SortMenuButton({ id }: { id: PaneId }) {
  const { t } = useTranslation();
  const { summary, keyLabel, sortOrder } = useSortSummary(id);
  return (
    <ToolButton
      className="toolbar-sort"
      label={summary}
      ariaLabel={summary}
      menu
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        usePanes.getState().setActivePane(id);
        useContextMenu
          .getState()
          .openAt(rect.left, rect.bottom + 4, sortMenuEntries(id, t));
      }}
    >
      {sortOrder === "asc" ? (
        <ArrowUpNarrowWide size={15} />
      ) : (
        <ArrowDownWideNarrow size={15} />
      )}
      <span className="toolbar-sort-label">{keyLabel}</span>
    </ToolButton>
  );
}
