import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import clsx from "clsx";
import type { Entry } from "@/types/bindings";
import {
  isParentEntry,
  type PaneId,
  type SortKey,
  type SortOrder,
} from "@/stores/panes";
import { setHoverEntry, clearHover } from "@/stores/previewHover";
import { useMarquee } from "@/hooks/useMarquee";
import { useEntryDrag } from "@/hooks/useEntryDrag";
import { useDragState } from "@/stores/dragState";
import { normRect, rowsInRect } from "@/lib/marquee";
import { EntryRow } from "./EntryRow";

interface EntryListProps {
  id: PaneId;
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  sortKey: SortKey;
  sortOrder: SortOrder;
  onCursorMove: (index: number, e?: React.MouseEvent) => void;
  onActivate: (entry: Entry, index: number) => void;
  onToggleSelect: (name: string) => void;
  onSortClick: (key: SortKey) => void;
  onEntryContextMenu: (
    e: React.MouseEvent,
    entry: Entry,
    index: number,
  ) => void;
  onEmptyContextMenu: (e: React.MouseEvent) => void;
}

const ROW_HEIGHT = 28;

/**
 * 가상 스크롤 파일 리스트 + 정렬 가능 컬럼 헤더.
 * 헤더 클릭 시 onSortClick — 같은 key 재클릭은 order toggle (store).
 * 빈 영역 드래그 = 마키 선택, 행 드래그 = 패널↔패널 DnD (복사 기본 / Ctrl=이동).
 */
export function EntryList({
  id,
  entries,
  cursorIndex,
  selected,
  sortKey,
  sortOrder,
  onCursorMove,
  onActivate,
  onToggleSelect: _onToggleSelect,
  onSortClick,
  onEntryContextMenu,
  onEmptyContextMenu,
}: EntryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const onEntryMouseDown = useEntryDrag(id);
  const dragActive = useDragState((s) => s.active);
  const overThisPane = useDragState((s) => s.overPane === id);
  const overFolder = useDragState((s) =>
    s.overPane === id ? s.overFolder : null,
  );

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const { marquee, onContainerMouseDown } = useMarquee({
    id,
    scrollRef: parentRef,
    entries,
    hitTest: (rect) =>
      rowsInRect(rect.y1, rect.y2, ROW_HEIGHT, entries.length).filter(
        (i) => !isParentEntry(entries[i]!),
      ),
  });

  useEffect(() => {
    if (cursorIndex >= 0) {
      virtualizer.scrollToIndex(cursorIndex, { align: "auto" });
    }
  }, [cursorIndex, virtualizer]);

  // 이 패널의 빈 영역 위로 드래그 중 (폴더 위가 아닐 때) — 패널 하이라이트
  const paneHighlight = dragActive && overThisPane && overFolder === null;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center border-b border-border bg-subtle text-meta text-fg-muted">
        <ColumnHeader
          label="Name"
          col="name"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="flex-1 px-2"
        />
        <ColumnHeader
          label="Size"
          col="size"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="w-20 px-2 text-right"
        />
        <ColumnHeader
          label="Modified"
          col="mtime"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="w-32 px-2 text-right"
        />
        <ColumnHeader
          label="Type"
          col="kind"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="w-16 px-2"
        />
      </div>
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
          if (!(e.target as HTMLElement).closest("[data-entry]"))
            onEmptyContextMenu(e);
        }}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((vi) => {
            const entry = entries[vi.index];
            if (entry === undefined) return null;
            // ".." 부모 행도 드롭 대상(→ 상위 폴더로 이동/복사). 드래그 소스는 useEntryDrag 가 제외.
            const isDropFolder = entry.kind === "dir";
            return (
              <div
                key={vi.key}
                data-entry={entry.name}
                data-drop-folder={isDropFolder ? entry.name : undefined}
                onMouseEnter={() => setHoverEntry(id, entry)}
                onMouseDown={(e) => {
                  // 아이콘/이름(드래그 핸들) 위에서만 항목 드래그 시작. 그 외
                  // (Size/Modified 컬럼 등 여백)은 컨테이너 마키 선택으로 흘려보냄.
                  if ((e.target as HTMLElement).closest("[data-drag-handle]")) {
                    onEntryMouseDown(e, entry);
                  }
                }}
                onContextMenu={(e) => onEntryContextMenu(e, entry, vi.index)}
                className={clsx(
                  dragActive &&
                    overFolder === entry.name &&
                    "ring-2 ring-inset ring-accent",
                )}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: `${vi.size}px`,
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                <EntryRow
                  entry={entry}
                  isCursor={cursorIndex === vi.index}
                  isSelected={selected.has(entry.name)}
                  onClick={(e) => onCursorMove(vi.index, e)}
                  onDoubleClick={() => onActivate(entry, vi.index)}
                />
              </div>
            );
          })}
          {marquee && <MarqueeBox rect={marquee} />}
        </div>
      </div>
    </div>
  );
}

/** 마키 선택 사각형 오버레이 (콘텐츠 좌표). */
function MarqueeBox({
  rect,
}: {
  rect: { x1: number; y1: number; x2: number; y2: number };
}) {
  const n = normRect(rect);
  return (
    <div
      className="pointer-events-none absolute z-10 border border-accent bg-accent/10"
      style={{ left: n.x1, top: n.y1, width: n.x2 - n.x1, height: n.y2 - n.y1 }}
    />
  );
}

function ColumnHeader({
  label,
  col,
  current,
  order,
  onClick,
  className,
}: {
  label: string;
  col: SortKey;
  current: SortKey;
  order: SortOrder;
  onClick: (key: SortKey) => void;
  className: string;
}) {
  const active = col === current;
  return (
    <button
      type="button"
      onClick={() => onClick(col)}
      className={`flex h-6 items-center gap-1 hover:text-fg ${className} ${active ? "text-fg" : ""}`}
    >
      <span>{label}</span>
      {active &&
        (order === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
  );
}
