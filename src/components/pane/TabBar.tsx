import { Fragment, useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePanes, type PaneId } from "@/stores/panes";
import { useReorderable } from "@/hooks/useReorderable";
import { useKeyHint } from "@/lib/keyHint";
import { useToast } from "@/stores/toast";
import { TabItem } from "./TabItem";
import { openTabMenu } from "./tabMenu";

/**
 * 패널 상단 탭 바. 탭 1개일 때는 렌더 X (새 탭은 PathBar 의 + 로) — 단 그 한
 * 장이 고정 탭이면 보인다(고정 상태와 해제 버튼이 보여야 하므로).
 *
 * - 고정(핀) 탭은 왼쪽에 모이고 일반 탭과 얇은 구분선으로 나뉜다.
 * - 끌어서 순서 변경 (핀 경계는 store 가 지킨다), 세로 휠도 가로 스크롤.
 * - 우클릭 = 탭 메뉴, 가운데 클릭 = 그 탭 닫기 (브라우저 관례, 핀 제외).
 */
export function TabBar({ id }: { id: PaneId }) {
  const { t: tr } = useTranslation();
  const tabs = usePanes((s) => s.panes[id].tabs);
  const activeIndex = usePanes((s) => s.panes[id].activeTabIndex);
  const openTab = usePanes((s) => s.openTab);
  const closeTab = usePanes((s) => s.closeTab);
  const selectTab = usePanes((s) => s.selectTab);
  const togglePinTab = usePanes((s) => s.togglePinTab);
  const reorderTabs = usePanes((s) => s.reorderTabs);
  const kNewTab = useKeyHint("tab.new");
  const group = `tabs-${id}`;
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group,
    axis: "x",
    keys: tabs.map((t) => t.id),
    onCommit: (ids) => reorderTabs(id, ids),
  });

  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const tab = strip?.querySelector<HTMLElement>(
      `[data-tab-index="${activeIndex}"]`,
    );
    if (!strip || !tab) return;
    // 창/보조 패널 크기가 바뀌어도 활성 탭을 노출한다.
    const reveal = () => {
      if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
      else if (
        tab.offsetLeft + tab.offsetWidth >
        strip.scrollLeft + strip.clientWidth
      )
        strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(strip);
    observer.observe(tab);
    return () => observer.disconnect();
  }, [activeIndex, tabs.length]);

  if (tabs.length === 0 || (tabs.length === 1 && !tabs[0]!.pinned)) return null;

  const close = (i: number) => {
    // 핀 탭은 store 가 거부한다 — 가운데 클릭이 "무반응"으로 보이지 않게 안내.
    if (!closeTab(id, i) && tabs[i]?.pinned)
      useToast.getState().show(tr("tabs.pinnedCannotClose"), "info");
  };
  const lastPinned = tabs.reduce((k, t, i) => (t.pinned ? i : k), -1);

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-subtle text-meta">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={tr("tabs.list")}
        // 넘친 탭은 스크롤바 없이 가로 스크롤 — 세로 휠만 있는 마우스로도 닿게.
        onWheel={(e) => {
          const strip = stripRef.current;
          if (strip && Math.abs(e.deltaY) > Math.abs(e.deltaX))
            strip.scrollLeft += e.deltaY;
        }}
        className="relative flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((t, i) => (
          <Fragment key={t.id}>
            {dragKey && insertBeforeKey === t.id && <DropLine />}
            <TabItem
              tab={t}
              index={i}
              active={i === activeIndex}
              reorderGroup={group}
              dragging={dragKey === t.id}
              onSelect={() => selectTab(id, i)}
              onClose={() => close(i)}
              onTogglePin={() => togglePinTab(id, i)}
              onContextMenu={(e) => openTabMenu(e, id, i)}
              onDragStart={(e) => onItemMouseDown(e, t.id)}
            />
            {i === lastPinned && i < tabs.length - 1 && (
              <div
                aria-hidden
                className="my-1.5 w-px shrink-0 bg-fg-muted/40"
              />
            )}
          </Fragment>
        ))}
        {dragKey && insertBeforeKey === null && <DropLine />}
      </div>
      <button
        type="button"
        onClick={() => openTab(id)}
        className="flex w-7 shrink-0 items-center justify-center text-fg-muted hover:bg-border hover:text-fg"
        aria-label={tr("tabs.newTab")}
        title={tr("pathbar.newTabTitle", { key: kNewTab })}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

/** 드래그 중 삽입 위치 표시 — 런처/사이드바 재정렬과 같은 모양. */
function DropLine() {
  return <div className="my-1 w-0.5 shrink-0 rounded bg-accent" />;
}
