import { useMemo } from "react";
import { TabBar } from "./TabBar";
import { PathBar } from "./PathBar";
import { PaneFilterBar } from "./PaneFilterBar";
import { PaneToolbar } from "./PaneToolbar";
import { EntryList } from "./EntryList";
import { EntryGrid } from "./EntryGrid";
import { usePanes, activeTab, computeDisplayed, isParentEntry, type PaneId } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
  onBack: (id: PaneId) => void;
  onForward: (id: PaneId) => void;
  /** "위로" — 부모 디렉토리(또는 아카이브 루트에서 빠져나가기)는 App 이 결정. */
  onUp: (id: PaneId) => void;
  onEntryContextMenu: (id: PaneId, entry: Entry, index: number, e: React.MouseEvent) => void;
  onEmptyContextMenu: (id: PaneId, e: React.MouseEvent) => void;
  /** 아카이브 browse 중 "Update archive" repack 트리거. */
  onUpdateArchive: (id: PaneId) => void;
}

/**
 * 좌/우 패널 한 쪽.
 * dumb component — IPC 호출은 App.tsx 가 일괄 처리.
 * displayed entries 는 store selector (raw → filter → hidden → sort) 결과.
 */
export function Pane({ id, onNavigate, onActivate, onRefresh, onBack, onForward, onUp, onEntryContextMenu, onEmptyContextMenu, onUpdateArchive }: PaneProps) {
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);
  const setSelected = usePanes((s) => s.setSelected);
  const clearSelection = usePanes((s) => s.clearSelection);
  const toggleSortKey = usePanes((s) => s.toggleSortKey);
  const setGridCols = usePanes((s) => s.setGridCols);
  const tab = usePanes((s) => activeTab(s, id));
  const editPathNonce = useUI((s) => s.editPathNonce);
  const editPathPane = useUI((s) => s.editPathPane);
  // selector 가 매번 새 배열을 반환하면 zustand v5 무한 re-render → useMemo 로
  // tab(안정 ref) 변경 시에만 재정렬. (activeTab 은 기존 tab ref 반환.)
  const displayed = useMemo(() => computeDisplayed(tab), [tab]);

  const goUp = () => onUp(id);

  // 행 클릭 — 일반: 단일 선택, Ctrl/Cmd: 토글, Shift: 커서에서 범위 선택.
  const handleEntryClick = (index: number, e?: React.MouseEvent) => {
    const entry = displayed[index];
    const selectable = entry && !isParentEntry(entry);
    if (e?.shiftKey && selectable) {
      const anchor = tab.cursorIndex >= 0 ? tab.cursorIndex : index;
      const lo = Math.min(anchor, index);
      const hi = Math.max(anchor, index);
      const names = displayed
        .slice(lo, hi + 1)
        .filter((x) => !isParentEntry(x))
        .map((x) => x.name);
      setSelected(id, names);
      setCursor(id, index);
    } else if (e && (e.ctrlKey || e.metaKey) && selectable) {
      toggleSelected(id, entry.name);
      setCursor(id, index);
    } else {
      clearSelection(id);
      setCursor(id, index);
    }
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
        archive={tab.archive}
        canBack={tab.history.index > 0}
        canForward={tab.history.index < tab.history.stack.length - 1}
        onBack={() => onBack(id)}
        onForward={() => onForward(id)}
        onUp={goUp}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
        onUpdateArchive={tab.archive ? () => onUpdateArchive(id) : undefined}
        editNonce={editPathNonce}
        editActive={editPathPane === id}
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
          onCursorMove={handleEntryClick}
          onActivate={(entry) => onActivate(id, entry)}
          onToggleSelect={(name) => toggleSelected(id, name)}
          onSortClick={(k) => toggleSortKey(id, k)}
          onEntryContextMenu={(e, entry, index) => onEntryContextMenu(id, entry, index, e)}
          onEmptyContextMenu={(e) => onEmptyContextMenu(id, e)}
        />
      ) : (
        <EntryGrid
          id={id}
          entries={displayed}
          mode={tab.viewMode}
          cursorIndex={tab.cursorIndex}
          selected={tab.selected}
          onCursorMove={handleEntryClick}
          onActivate={(entry) => onActivate(id, entry)}
          onColumns={(c) => setGridCols(id, c)}
          onEntryContextMenu={(e, entry, index) => onEntryContextMenu(id, entry, index, e)}
          onEmptyContextMenu={(e) => onEmptyContextMenu(id, e)}
        />
      )}
    </div>
  );
}
