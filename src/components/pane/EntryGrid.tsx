import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { FolderUp } from "lucide-react";
import clsx from "clsx";
import type { Entry } from "@/types/bindings";
import { gridColumns, isParentEntry, type PaneId } from "@/stores/panes";
import { setHoverEntry, clearHover } from "@/stores/previewHover";
import { formatSize, formatTime } from "@/lib/format";
import { EntryIcon } from "@/lib/fileIcon";
import { useMarquee } from "@/hooks/useMarquee";
import { useEntryDrag } from "@/hooks/useEntryDrag";
import { useDragState } from "@/stores/dragState";
import { cellsInRect, normRect } from "@/lib/marquee";

interface EntryGridProps {
  id: PaneId;
  entries: Entry[];
  mode: "grid" | "tiles";
  cursorIndex: number;
  selected: Set<string>;
  onCursorMove: (index: number, e?: React.MouseEvent) => void;
  onActivate: (entry: Entry, index: number) => void;
  /** grid 컬럼 수를 store 에 보고 (키보드 ↑↓ 이동폭 공유). tiles 는 1. */
  onColumns: (cols: number) => void;
  onEntryContextMenu: (e: React.MouseEvent, entry: Entry, index: number) => void;
  onEmptyContextMenu: (e: React.MouseEvent) => void;
}

const GRID_CELL_HEIGHT = 92;
const TILE_HEIGHT = 48;

/**
 * Grid / Tiles 뷰 — 가상 스크롤.
 * - grid: 폭 기반 N 컬럼, 큰 아이콘 + 파일명. 썸네일은 후속(아이콘 기반).
 * - tiles: 단일 컬럼 큰 행, 아이콘 + 이름 + 메타.
 * cursor/selected 표시는 EntryRow 와 동일 의미(border-accent / bg-active).
 */
export function EntryGrid({
  id,
  entries,
  mode,
  cursorIndex,
  selected,
  onCursorMove,
  onActivate,
  onColumns,
  onEntryContextMenu,
  onEmptyContextMenu,
}: EntryGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef(1);
  const onEntryMouseDown = useEntryDrag(id);
  const dragActive = useDragState((s) => s.active);
  const overThisPane = useDragState((s) => s.overPane === id);
  const overFolder = useDragState((s) => (s.overPane === id ? s.overFolder : null));

  // 폭 측정 → grid 컬럼 수 계산 후 store 보고. tiles 는 항상 1.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const report = () => {
      const cols = mode === "grid" ? gridColumns(el.clientWidth) : 1;
      if (cols !== colsRef.current) {
        colsRef.current = cols;
        onColumns(cols);
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, onColumns]);

  const cols = mode === "grid" ? Math.max(1, colsRef.current) : 1;
  const rowHeight = mode === "grid" ? GRID_CELL_HEIGHT : TILE_HEIGHT;
  const rowCount = Math.ceil(entries.length / cols);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  useEffect(() => {
    if (cursorIndex >= 0) {
      virtualizer.scrollToIndex(Math.floor(cursorIndex / cols), { align: "auto" });
    }
  }, [cursorIndex, cols, virtualizer]);

  const { marquee, onContainerMouseDown } = useMarquee({
    id,
    scrollRef: parentRef,
    entries,
    hitTest: (rect) => {
      const el = parentRef.current;
      if (!el) return [];
      const c = mode === "grid" ? Math.max(1, colsRef.current) : 1;
      return cellsInRect(rect, c, el.clientWidth / c, rowHeight, entries.length).filter(
        (i) => !isParentEntry(entries[i]!),
      );
    },
  });

  const paneHighlight = dragActive && overThisPane && overFolder === null;

  return (
    <div
      ref={parentRef}
      data-drop-pane={id}
      className={clsx(
        "flex-1 min-h-0 overflow-auto",
        paneHighlight && "ring-2 ring-inset ring-accent",
      )}
      onMouseDown={onContainerMouseDown}
      onMouseLeave={clearHover}
      onContextMenu={(e) => {
        if (!(e.target as HTMLElement).closest("[data-entry]")) onEmptyContextMenu(e);
      }}
    >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((vrow) => {
          const start = vrow.index * cols;
          const rowEntries = entries.slice(start, start + cols);
          return (
            <div
              key={vrow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: `${vrow.size}px`,
                transform: `translateY(${vrow.start}px)`,
                ...(mode === "grid"
                  ? { display: "grid", gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }
                  : { display: "flex", flexDirection: "column" as const }),
              }}
            >
              {rowEntries.map((entry, i) => {
                const index = start + i;
                const isCursor = cursorIndex === index;
                const isSelected = selected.has(entry.name);
                const cellProps: CellProps = {
                  entry,
                  isCursor,
                  isSelected,
                  highlight: dragActive && overFolder === entry.name,
                  onMouseEnter: () => setHoverEntry(id, entry),
                  onMouseDown: (e) => {
                    // 아이콘/이름(핸들) 위에서만 드래그 시작 — 그 외 여백은 마키로.
                    if ((e.target as HTMLElement).closest("[data-drag-handle]")) {
                      onEntryMouseDown(e, entry);
                    }
                  },
                  onContextMenu: (e) => onEntryContextMenu(e, entry, index),
                  onClick: (e: React.MouseEvent) => onCursorMove(index, e),
                  onDoubleClick: () => onActivate(entry, index),
                };
                return mode === "grid" ? (
                  <GridCell key={entry.name} {...cellProps} />
                ) : (
                  <TileRow key={entry.name} {...cellProps} />
                );
              })}
            </div>
          );
        })}
        {marquee && (
          <div
            className="pointer-events-none absolute z-10 border border-accent bg-accent/10"
            style={(() => {
              const n = normRect(marquee);
              return { left: n.x1, top: n.y1, width: n.x2 - n.x1, height: n.y2 - n.y1 };
            })()}
          />
        )}
      </div>
    </div>
  );
}

interface CellProps {
  entry: Entry;
  isCursor: boolean;
  isSelected: boolean;
  highlight: boolean;
  onMouseEnter: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

function GridCell({ entry, isCursor, isSelected, highlight, onMouseEnter, onMouseDown, onContextMenu, onClick, onDoubleClick }: CellProps) {
  if (isParentEntry(entry)) {
    return (
      <div
        data-entry={entry.name}
        onMouseEnter={onMouseEnter}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title="Parent folder"
        className={clsx(
          "m-1 flex flex-col items-center justify-center gap-1 rounded-panel border border-transparent p-2 cursor-default hover:bg-subtle",
          isCursor && "border-accent",
        )}
      >
        <FolderUp size={32} className="text-fg-muted" />
        <span className="font-mono text-center text-meta text-fg-muted">..</span>
      </div>
    );
  }
  return (
    <div
      data-entry={entry.name}
      data-drop-folder={entry.kind === "dir" ? entry.name : undefined}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={clsx(
        "m-1 flex flex-col items-center justify-center gap-1 rounded-panel border p-2 cursor-default",
        // 선택 셀은 hover 회색으로 덮지 않음 (마키 드래그 중 파란 선택색 유지).
        isSelected ? "bg-active" : "border-transparent hover:bg-subtle",
        isCursor ? "border-accent" : "border-transparent",
        highlight && "ring-2 ring-inset ring-accent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* 드래그 핸들 = 아이콘+이름. 셀 여백/간격은 마키 시작 영역. */}
      <span data-drag-handle className="flex flex-col items-center gap-1">
        <EntryIcon entry={entry} size={32} />
        <span
          className={clsx(
            "font-mono text-meta text-center line-clamp-2 break-all",
            entry.hidden && "text-fg-muted",
          )}
        >
          {entry.name}
        </span>
      </span>
    </div>
  );
}

function TileRow({ entry, isCursor, isSelected, highlight, onMouseEnter, onMouseDown, onContextMenu, onClick, onDoubleClick }: CellProps) {
  if (isParentEntry(entry)) {
    return (
      <div
        data-entry={entry.name}
        onMouseEnter={onMouseEnter}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title="Parent folder"
        className={clsx(
          "flex h-12 items-center gap-3 px-3 cursor-default hover:bg-subtle",
          isCursor ? "border-l-2 border-l-accent pl-[10px]" : "border-l-2 border-l-transparent",
        )}
      >
        <FolderUp size={24} className="text-fg-muted" />
        <span className="font-mono text-fg-muted">..</span>
      </div>
    );
  }
  return (
    <div
      data-entry={entry.name}
      data-drop-folder={entry.kind === "dir" ? entry.name : undefined}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      className={clsx(
        "flex h-12 items-center gap-3 px-3 cursor-default",
        // 선택 행은 hover 회색으로 덮지 않음 (마키 드래그 중 파란 선택색 유지).
        isSelected ? "bg-active" : "hover:bg-subtle",
        isCursor ? "border-l-2 border-l-accent pl-[10px]" : "border-l-2 border-l-transparent",
        highlight && "ring-2 ring-inset ring-accent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* 드래그 핸들 = 아이콘+이름/메타. 행 우측 여백은 마키 시작 영역. */}
      <span data-drag-handle className="flex min-w-0 items-center gap-3">
        <EntryIcon entry={entry} size={24} />
        <div className="flex min-w-0 flex-col">
          <span className={clsx("font-mono truncate", entry.hidden && "text-fg-muted")}>
            {entry.name}
          </span>
          <span className="text-meta text-fg-muted">
            {formatSize(entry.size)} · {formatTime(entry.modified_ms)}
          </span>
        </div>
      </span>
    </div>
  );
}
