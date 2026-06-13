import { useMemo } from "react";
import { TabBar } from "./TabBar";
import { PathBar } from "./PathBar";
import { PaneFilterBar } from "./PaneFilterBar";
import { PaneToolbar } from "./PaneToolbar";
import { EntryList } from "./EntryList";
import { EntryGrid } from "./EntryGrid";
import { usePanes, activeTab, computeDisplayed, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
  onBack: (id: PaneId) => void;
  onForward: (id: PaneId) => void;
}

/**
 * 좌/우 패널 한 쪽.
 * dumb component — IPC 호출은 App.tsx 가 일괄 처리.
 * displayed entries 는 store selector (raw → filter → hidden → sort) 결과.
 */
export function Pane({ id, onNavigate, onActivate, onRefresh, onBack, onForward }: PaneProps) {
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);
  const toggleSortKey = usePanes((s) => s.toggleSortKey);
  const setGridCols = usePanes((s) => s.setGridCols);
  const tab = usePanes((s) => activeTab(s, id));
  // selector 가 매번 새 배열을 반환하면 zustand v5 무한 re-render → useMemo 로
  // tab(안정 ref) 변경 시에만 재정렬. (activeTab 은 기존 tab ref 반환.)
  const displayed = useMemo(() => computeDisplayed(tab), [tab]);

  const goUp = () => {
    const path = tab.location.path;
    if (path === "/" || path.length === 0) return;
    const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
    onNavigate(id, parent);
  };

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col min-h-0 overflow-hidden rounded-panel border border-border",
        isActive && "border-accent",
      )}
      onMouseDown={() => setActivePane(id)}
    >
      <TabBar id={id} />
      <PathBar
        location={tab.location}
        canBack={tab.history.index > 0}
        canForward={tab.history.index < tab.history.stack.length - 1}
        onBack={() => onBack(id)}
        onForward={() => onForward(id)}
        onUp={goUp}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
      />
      <PaneToolbar
        id={id}
        canBack={tab.history.index > 0}
        canForward={tab.history.index < tab.history.stack.length - 1}
        onBack={() => onBack(id)}
        onForward={() => onForward(id)}
        onUp={goUp}
        onRefresh={() => onRefresh(id)}
      />
      <PaneFilterBar id={id} />
      {tab.viewMode === "details" ? (
        <EntryList
          id={id}
          entries={displayed}
          cursorIndex={tab.cursorIndex}
          selected={tab.selected}
          sortKey={tab.sortKey}
          sortOrder={tab.sortOrder}
          onCursorMove={(i) => setCursor(id, i)}
          onActivate={(entry) => onActivate(id, entry)}
          onToggleSelect={(name) => toggleSelected(id, name)}
          onSortClick={(k) => toggleSortKey(id, k)}
        />
      ) : (
        <EntryGrid
          id={id}
          entries={displayed}
          mode={tab.viewMode}
          cursorIndex={tab.cursorIndex}
          selected={tab.selected}
          onCursorMove={(i) => setCursor(id, i)}
          onActivate={(entry) => onActivate(id, entry)}
          onColumns={(c) => setGridCols(id, c)}
        />
      )}
    </div>
  );
}
