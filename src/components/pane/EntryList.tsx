import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import type { Entry } from "@/types/bindings";
import { EntryRow } from "./EntryRow";

interface EntryListProps {
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  onCursorMove: (index: number) => void;
  onActivate: (entry: Entry, index: number) => void;
  onToggleSelect: (name: string) => void;
}

const ROW_HEIGHT = 28;

/**
 * 가상 스크롤 파일 리스트.
 * 1만+ 항목에서도 즉각 응답. DESIGN.md "파일 리스트 (EntryList)" 참조.
 */
export function EntryList({
  entries,
  cursorIndex,
  selected,
  onCursorMove,
  onActivate,
  onToggleSelect: _onToggleSelect,
}: EntryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // 키보드 네비게이션 시 커서가 viewport 밖으로 나가지 않도록 스크롤
  useEffect(() => {
    if (cursorIndex >= 0) {
      virtualizer.scrollToIndex(cursorIndex, { align: "auto" });
    }
  }, [cursorIndex, virtualizer]);

  return (
    <div ref={parentRef} className="flex-1 min-h-0 overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: "relative",
        }}
      >
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
                onClick={() => {
                  onCursorMove(vi.index);
                }}
                onDoubleClick={() => onActivate(entry, vi.index)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
