import { PathBar } from "./PathBar";
import { EntryList } from "./EntryList";
import { usePanes, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import clsx from "clsx";

interface PaneProps {
  id: PaneId;
  onNavigate: (id: PaneId, path: string) => void;
  onActivate: (id: PaneId, entry: Entry) => void;
  onRefresh: (id: PaneId) => void;
}

/**
 * 좌/우 패널 한 쪽.
 * dumb component — IPC 호출은 App.tsx가 일괄 처리, 여기는 props로 받아 store 표시만.
 * active 패널은 border-accent 로 강조 (DESIGN.md).
 */
export function Pane({ id, onNavigate, onActivate, onRefresh }: PaneProps) {
  const pane = usePanes((s) => s.panes[id]);
  const isActive = usePanes((s) => s.activePane === id);
  const setActivePane = usePanes((s) => s.setActivePane);
  const setCursor = usePanes((s) => s.setCursor);
  const toggleSelected = usePanes((s) => s.toggleSelected);

  return (
    <div
      className={clsx(
        "flex flex-1 flex-col min-h-0 border border-border",
        isActive && "border-accent",
      )}
      onMouseDown={() => setActivePane(id)}
    >
      <PathBar
        location={pane.location}
        onUp={() => {
          const path = pane.location.path;
          if (path === "/" || path.length === 0) return;
          const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
          onNavigate(id, parent);
        }}
        onSegmentClick={(p) => onNavigate(id, p)}
        onRefresh={() => onRefresh(id)}
      />
      <EntryList
        entries={pane.entries}
        cursorIndex={pane.cursorIndex}
        selected={pane.selected}
        onCursorMove={(i) => setCursor(id, i)}
        onActivate={(entry) => onActivate(id, entry)}
        onToggleSelect={(name) => toggleSelected(id, name)}
      />
    </div>
  );
}
