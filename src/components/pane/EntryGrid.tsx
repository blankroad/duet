import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { FolderUp } from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import clsx from "clsx";
import type { Entry, EntryRef, Location } from "@/types/bindings";
import {
  activeTab,
  gridColumns,
  isParentEntry,
  usePanes,
  type PaneId,
} from "@/stores/panes";
import { setHoverEntry, clearHover } from "@/stores/previewHover";
import { useUI } from "@/stores/ui";
import { InlineRenameInput } from "./InlineRenameInput";
import { formatSize, formatTime } from "@/lib/format";
import { EntryIcon } from "@/lib/fileIcon";
import { useAppSettings } from "@/stores/settings";
import { thumbUrl } from "@/lib/previewUrl";
import { childLocation } from "@/lib/entryDnd";
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
  onEntryContextMenu: (
    e: React.MouseEvent,
    entry: Entry,
    index: number,
  ) => void;
  onEmptyContextMenu: (e: React.MouseEvent) => void;
  /** 인라인 이름변경 성공 후 목록 새로고침 (원격은 fs watcher 가 없음). */
  onRenamed: () => void;
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
  onRenamed,
}: EntryGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const colsRef = useRef(1);
  const renameTarget = useUI((s) => s.renameTarget);
  // 썸네일 URL 빌드용 — 현재 패널 폴더 location.
  const location = usePanes((s) => activeTab(s, id).location);
  // "크기 계산" 결과 — 타일 메타의 폴더 크기 표시.
  const dirSizes = usePanes((s) => activeTab(s, id).dirSizes);
  const onEntryMouseDown = useEntryDrag(id);
  const dragActive = useDragState((s) => s.active);
  const overThisPane = useDragState((s) => s.overPane === id);
  const overFolder = useDragState((s) =>
    s.overPane === id ? s.overFolder : null,
  );

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
      virtualizer.scrollToIndex(Math.floor(cursorIndex / cols), {
        align: "auto",
      });
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
      return cellsInRect(
        rect,
        c,
        el.clientWidth / c,
        rowHeight,
        entries.length,
      ).filter((i) => !isParentEntry(entries[i]!));
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
                  ? {
                      display: "grid",
                      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                    }
                  : { display: "flex", flexDirection: "column" as const }),
              }}
            >
              {rowEntries.map((entry, i) => {
                const index = start + i;
                const isCursor = cursorIndex === index;
                const isSelected = selected.has(entry.name);
                const cellProps: CellProps = {
                  entry,
                  location,
                  isCursor,
                  isSelected,
                  dirSize: dirSizes[entry.name],
                  highlight: dragActive && overFolder === entry.name,
                  renameRef:
                    renameTarget?.pane === id &&
                    renameTarget.name === entry.name &&
                    !isParentEntry(entry)
                      ? { location, name: entry.name }
                      : null,
                  onRenameDone: (renamed) => {
                    useUI.getState().clearInlineRename();
                    if (renamed) onRenamed();
                  },
                  onMouseEnter: () => setHoverEntry(id, entry),
                  onMouseDown: (e) => {
                    // 아이콘/이름(핸들) 위에서만 드래그 시작 — 그 외 여백은 마키로.
                    if (
                      (e.target as HTMLElement).closest("[data-drag-handle]")
                    ) {
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
              return {
                left: n.x1,
                top: n.y1,
                width: n.x2 - n.x1,
                height: n.y2 - n.y1,
              };
            })()}
          />
        )}
      </div>
    </div>
  );
}

interface CellProps {
  entry: Entry;
  location: Location;
  isCursor: boolean;
  isSelected: boolean;
  /** "크기 계산" 결과(bytes) — 타일 메타의 크기 표시에 사용. */
  dirSize?: number | undefined;
  highlight: boolean;
  /** 인라인 이름변경(F2) 중이면 대상 EntryRef — 이름 라벨이 input 으로 전환. */
  renameRef: EntryRef | null;
  onRenameDone: (renamed: boolean) => void;
  onMouseEnter: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

/** 썸네일 대상 이미지 확장자(백엔드 활성 코덱과 일치). 로컬·원격 모두. */
const THUMB_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
/** OS 셸 썸네일 대상(영상). 백엔드 is_os_thumbnailable 과 일치 — 로컬+지원 OS 만. */
const OS_THUMB_EXTS = new Set([
  "mp4",
  "mkv",
  "mov",
  "avi",
  "webm",
  "wmv",
  "flv",
  "m4v",
  "mpg",
  "mpeg",
  "3gp",
  "m2ts",
  "mts",
  "ogv",
]);
/** OS 셸 썸네일을 쓰는 플랫폼인가 (현재 Windows. macOS QuickLook 은 후속). */
const osThumbs = platform() === "windows";

function isThumbable(e: Entry, location: Location): boolean {
  if (e.kind !== "file") return false;
  const i = e.name.lastIndexOf(".");
  if (i < 0) return false;
  const ext = e.name.slice(i + 1).toLowerCase();
  if (THUMB_EXTS.has(ext)) return true;
  // 영상 등은 OS 셸 썸네일 — 지원 플랫폼 + 로컬 파일만(원격은 비싸서 아이콘).
  return osThumbs && location.source.kind === "local" && OS_THUMB_EXTS.has(ext);
}

/**
 * 썸네일 또는 아이콘 — 설정 ON + 이미지면 `duet-thumb://` 이미지, 아니면/실패 시 타입 아이콘.
 * `loading="lazy"` 로 화면에 들어올 때만 요청, onError 시 아이콘 fallback.
 */
function Thumb({
  entry,
  location,
  size,
}: {
  entry: Entry;
  location: Location;
  size: number;
}) {
  const show = useAppSettings((s) => s.showThumbnails);
  const [failed, setFailed] = useState(false);
  if (!show || failed || !isThumbable(entry, location)) {
    return (
      <EntryIcon
        entry={entry}
        size={size}
        localPath={
          location.source.kind === "local"
            ? childLocation(location, entry.name).path
            : null
        }
      />
    );
  }
  return (
    <img
      src={thumbUrl(childLocation(location, entry.name))}
      loading="lazy"
      decoding="async"
      alt=""
      onError={() => setFailed(true)}
      className="shrink-0 rounded object-cover bg-subtle"
      style={{ width: size, height: size }}
    />
  );
}

function GridCell({
  entry,
  location,
  isCursor,
  isSelected,
  highlight,
  renameRef,
  onRenameDone,
  onMouseEnter,
  onMouseDown,
  onContextMenu,
  onClick,
  onDoubleClick,
}: CellProps) {
  if (isParentEntry(entry)) {
    return (
      <div
        data-entry={entry.name}
        data-drop-folder={entry.name}
        onMouseEnter={onMouseEnter}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title="Parent folder — drop here to move/copy up"
        className={clsx(
          "m-1 flex flex-col items-center justify-center gap-1 rounded-panel border border-transparent p-2 cursor-default hover:bg-subtle",
          isCursor && "border-accent",
          highlight && "ring-2 ring-inset ring-accent",
        )}
      >
        <FolderUp size={32} className="text-fg-muted" />
        <span className="font-mono text-center text-meta text-fg-muted">
          ..
        </span>
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
        <Thumb entry={entry} location={location} size={48} />
        {renameRef ? (
          <InlineRenameInput
            target={renameRef}
            isDir={entry.kind === "dir"}
            onDone={onRenameDone}
            className="w-full text-center text-meta"
          />
        ) : (
          <span
            className={clsx(
              "font-mono text-meta text-center line-clamp-2 break-all",
              entry.hidden && "text-fg-muted",
            )}
          >
            {entry.name}
          </span>
        )}
      </span>
    </div>
  );
}

function TileRow({
  entry,
  location,
  isCursor,
  isSelected,
  dirSize,
  highlight,
  renameRef,
  onRenameDone,
  onMouseEnter,
  onMouseDown,
  onContextMenu,
  onClick,
  onDoubleClick,
}: CellProps) {
  if (isParentEntry(entry)) {
    return (
      <div
        data-entry={entry.name}
        data-drop-folder={entry.name}
        onMouseEnter={onMouseEnter}
        onMouseDown={onMouseDown}
        onContextMenu={onContextMenu}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title="Parent folder — drop here to move/copy up"
        className={clsx(
          "flex h-12 items-center gap-3 px-3 cursor-default hover:bg-subtle",
          isCursor
            ? "border-l-2 border-l-accent pl-[10px]"
            : "border-l-2 border-l-transparent",
          highlight && "ring-2 ring-inset ring-accent",
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
        isCursor
          ? "border-l-2 border-l-accent pl-[10px]"
          : "border-l-2 border-l-transparent",
        highlight && "ring-2 ring-inset ring-accent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* 드래그 핸들 = 아이콘+이름/메타. 행 우측 여백은 마키 시작 영역. */}
      <span data-drag-handle className="flex min-w-0 items-center gap-3">
        <Thumb entry={entry} location={location} size={24} />
        <div className="flex min-w-0 flex-col">
          {renameRef ? (
            <InlineRenameInput
              target={renameRef}
              isDir={entry.kind === "dir"}
              onDone={onRenameDone}
              className="text-base"
            />
          ) : (
            <span
              className={clsx(
                "font-mono truncate",
                entry.hidden && "text-fg-muted",
              )}
            >
              {entry.name}
            </span>
          )}
          <span className="text-meta text-fg-muted">
            {formatSize(dirSize ?? entry.size)} ·{" "}
            {formatTime(entry.modified_ms)}
          </span>
        </div>
      </span>
    </div>
  );
}
