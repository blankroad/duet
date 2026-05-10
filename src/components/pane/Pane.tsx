import { TabBar } from "./TabBar";
import { PathBar } from "./PathBar";
import { PaneFilterBar } from "./PaneFilterBar";
import { EntryList } from "./EntryList";
import { usePanes, activeTab, selectDisplayedEntries, type PaneId } from "@/stores/panes";
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
  const tab = usePanes((s) => activeTab(s, id));
  const displayed = usePanes((s) => selectDisplayedEntries(id, s));

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col min-h-0 border border-border",
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
        onUp={() => {
          const path = tab.location.path;
          if (path === "/" || path.length === 0) return;
          const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
          onNavigate(id, parent);
        }}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
      />
      <PaneFilterBar id={id} />
      <EntryList
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
    </div>
  );
}
