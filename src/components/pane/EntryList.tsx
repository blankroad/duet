import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, type CSSProperties } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import clsx from "clsx";
import type { Entry } from "@/types/bindings";
import {
  activeTab,
  isParentEntry,
  usePanes,
  type PaneId,
  type SortKey,
  type SortOrder,
} from "@/stores/panes";
import { childLocation } from "@/lib/entryDnd";
import { setHoverEntry, clearHover } from "@/stores/previewHover";
import { useUI, densityMetrics } from "@/stores/ui";
import { useContextMenu } from "@/stores/contextMenu";
import { useMarquee } from "@/hooks/useMarquee";
import { useEntryDrag } from "@/hooks/useEntryDrag";
import { useDragState } from "@/stores/dragState";
import { normRect, rowsInRect } from "@/lib/marquee";
import { EntryRow } from "./EntryRow";
import { useColumnWidths, type ColKey } from "@/stores/columnWidths";

/** 리사이즈 폭 clamp (store 와 동일 범위). */
const clampCol = (px: number) => Math.max(40, Math.min(600, Math.round(px)));

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
  /** 인라인 이름변경 성공 후 목록 새로고침 (원격은 fs watcher 가 없음). */
  onRenamed: () => void;
}


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
  onRenamed,
}: EntryListProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const onEntryMouseDown = useEntryDrag(id);
  const splitExt = useUI((s) => s.splitExt);
  const renameTarget = useUI((s) => s.renameTarget);
  // 밀도(행 높이) — 가상 스크롤 estimateSize/마키 hitTest 와 행 렌더가 공유.
  const rowHeight = densityMetrics(useUI((s) => s.density)).row;
  // OS 아이콘(EntryIcon localPath)용 — 현재 패널 폴더 location. 원격이면 null 전달.
  const location = usePanes((s) => activeTab(s, id).location);
  // "크기 계산" 결과(name → bytes) — 폴더 행의 크기 컬럼 표시.
  const dirSizes = usePanes((s) => activeTab(s, id).dirSizes);
  const dragActive = useDragState((s) => s.active);
  const overThisPane = useDragState((s) => s.overPane === id);
  const overFolder = useDragState((s) =>
    s.overPane === id ? s.overFolder : null,
  );

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 8,
  });

  // 밀도 전환 시 캐시된 행 높이 재측정.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const { marquee, onContainerMouseDown } = useMarquee({
    id,
    scrollRef: parentRef,
    entries,
    hitTest: (rect) =>
      rowsInRect(rect.y1, rect.y2, rowHeight, entries.length).filter(
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

  // 컬럼 헤더 우클릭 → 컬럼 옵션(확장자 분리 토글) — 탐색기/엑셀 관례.
  const onHeaderContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    useContextMenu.getState().openAt(e.clientX, e.clientY, [
      {
        id: "split-ext",
        label: splitExt ? "Hide extension column" : "Show extension column",
        onSelect: () => useUI.getState().toggleSplitExt(),
      },
    ]);
  };

  // 컬럼 폭(Ext/Size/Modified) — 헤더 경계 드래그로 조절. CSS 변수(--col-*)로 헤더·행이
  // 공유해 항상 정렬. 드래그 중엔 변수만 직접 갱신(리렌더 X), 놓을 때 store 커밋(영속).
  const outerRef = useRef<HTMLDivElement>(null);
  const colExt = useColumnWidths((s) => s.ext);
  const colSize = useColumnWidths((s) => s.size);
  const colMtime = useColumnWidths((s) => s.mtime);
  const setColWidth = useColumnWidths((s) => s.setWidth);
  const startResize = (col: ColKey, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // 헤더 정렬 클릭 방지
    const startX = e.clientX;
    const startW = useColumnWidths.getState()[col];
    // 왼쪽 경계를 잡고 드래그 — 왼쪽으로 끌면 그 컬럼이 넓어짐(Name 이 흡수).
    const width = (ev: PointerEvent) => clampCol(startW + (startX - ev.clientX));
    const move = (ev: PointerEvent) =>
      outerRef.current?.style.setProperty(`--col-${col}`, `${width(ev)}px`);
    const up = (ev: PointerEvent) => {
      setColWidth(col, width(ev));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      ref={outerRef}
      className="flex flex-1 min-h-0 flex-col"
      style={
        {
          "--col-ext": `${colExt}px`,
          "--col-size": `${colSize}px`,
          "--col-mtime": `${colMtime}px`,
        } as CSSProperties
      }
    >
      {/* 컬럼 폭은 CSS 변수(--col-*)로 헤더·행이 공유 → 항상 정렬. 간격 gap-2 px-2 동일.
          Name flex-1, Ext/Size/Modified 는 var 폭(드래그 조절). 우측 컬럼은 justify-end. */}
      <div
        className="flex h-6 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-meta text-fg-muted"
        onContextMenu={onHeaderContextMenu}
      >
        <ColumnHeader
          label="Name"
          col="name"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="min-w-0 flex-1"
        />
        {splitExt && (
          <ColumnHeader
            label="Ext"
            col="ext"
            current={sortKey}
            order={sortOrder}
            onClick={onSortClick}
            className="w-[var(--col-ext)]"
            resizeCol="ext"
            onResizeStart={startResize}
          />
        )}
        <ColumnHeader
          label="Size"
          col="size"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="w-[var(--col-size)] justify-end"
          resizeCol="size"
          onResizeStart={startResize}
        />
        <ColumnHeader
          label="Modified"
          col="mtime"
          current={sortKey}
          order={sortOrder}
          onClick={onSortClick}
          className="w-[var(--col-mtime)] justify-end"
          resizeCol="mtime"
          onResizeStart={startResize}
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
                  splitExt={splitExt}
                  localPath={
                    location.source.kind === "local"
                      ? childLocation(location, entry.name).path
                      : null
                  }
                  dirSize={dirSizes[entry.name]}
                  renameRef={
                    renameTarget?.pane === id &&
                    renameTarget.name === entry.name &&
                    !isParentEntry(entry)
                      ? { location, name: entry.name }
                      : null
                  }
                  onRenameDone={(renamed) => {
                    useUI.getState().clearInlineRename();
                    if (renamed) onRenamed();
                  }}
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
  resizeCol,
  onResizeStart,
}: {
  label: string;
  col: SortKey;
  current: SortKey;
  order: SortOrder;
  onClick: (key: SortKey) => void;
  className: string;
  /** 지정 시 왼쪽 경계에 드래그 리사이즈 핸들을 렌더 — 이 컬럼 폭을 조절. */
  resizeCol?: ColKey;
  onResizeStart?: (col: ColKey, e: React.PointerEvent) => void;
}) {
  const active = col === current;
  return (
    <button
      type="button"
      onClick={() => onClick(col)}
      className={`relative flex h-6 items-center gap-1 hover:text-fg ${className} ${active ? "text-fg" : ""}`}
    >
      {resizeCol && onResizeStart && (
        <div
          onPointerDown={(e) => onResizeStart(resizeCol, e)}
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent/50"
          title="Drag to resize column"
        />
      )}
      <span>{label}</span>
      {active &&
        (order === "asc" ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
  );
}
