import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { Entry } from "@/types/bindings";
import type { SortKey, SortOrder } from "@/stores/panes";
import { EntryRow } from "./EntryRow";

interface EntryListProps {
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  sortKey: SortKey;
  sortOrder: SortOrder;
  onCursorMove: (index: number) => void;
  onActivate: (entry: Entry, index: number) => void;
  onToggleSelect: (name: string) => void;
  onSortClick: (key: SortKey) => void;
}

const ROW_HEIGHT = 28;

/**
 * 가상 스크롤 파일 리스트 + 정렬 가능 컬럼 헤더.
 * 헤더 클릭 시 onSortClick — 같은 key 재클릭은 order toggle (store).
 */
export function EntryList({
  entries,
  cursorIndex,
  selected,
  sortKey,
  sortOrder,
  onCursorMove,
  onActivate,
  onToggleSelect: _onToggleSelect,
  onSortClick,
}: EntryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  useEffect(() => {
    if (cursorIndex >= 0) {
      virtualizer.scrollToIndex(cursorIndex, { align: "auto" });
    }
  }, [cursorIndex, virtualizer]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex h-6 shrink-0 items-center border-b border-border bg-subtle text-meta text-fg-muted">
        <ColumnHeader label="Name" col="name" current={sortKey} order={sortOrder} onClick={onSortClick} className="flex-1 px-2" />
        <ColumnHeader label="Size" col="size" current={sortKey} order={sortOrder} onClick={onSortClick} className="w-20 px-2 text-right" />
        <ColumnHeader label="Modified" col="mtime" current={sortKey} order={sortOrder} onClick={onSortClick} className="w-32 px-2 text-right" />
        <ColumnHeader label="Type" col="kind" current={sortKey} order={sortOrder} onClick={onSortClick} className="w-16 px-2" />
      </div>
      <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const entry = entries[vi.index];
            if (entry === undefined) return null;
            return (
              <div
                key={vi.key}
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
                  onClick={() => onCursorMove(vi.index)}
                  onDoubleClick={() => onActivate(entry, vi.index)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
      {active && (order === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
  );
}
