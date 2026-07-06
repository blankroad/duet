import { FolderUp } from "lucide-react";
import type { Entry, EntryRef } from "@/types/bindings";
import { formatSize, formatTime } from "@/lib/format";
import { splitNameExt } from "@/lib/fileInfo";
import { EntryIcon } from "@/lib/fileIcon";
import { isParentEntry } from "@/stores/panes";
import { InlineRenameInput } from "./InlineRenameInput";
import clsx from "clsx";

interface EntryRowProps {
  entry: Entry;
  isCursor: boolean;
  isSelected: boolean;
  /** 확장자를 별도 컬럼으로 분리 (TC 식). */
  splitExt: boolean;
  /** OS 아이콘 조회용 로컬 절대경로 — 원격 패널이면 null(글리프). */
  localPath: string | null;
  /** "크기 계산"으로 구한 폴더 재귀 크기(bytes) — 있으면 크기 컬럼에 표시. */
  dirSize?: number | undefined;
  /** 인라인 이름변경(F2) 중이면 대상 EntryRef — 이름 셀이 input 으로 전환. */
  renameRef?: EntryRef | null;
  onRenameDone?: (renamed: boolean) => void;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}

/**
 * DESIGN.md "행 (EntryRow)" 디자인.
 * - hover: bg-subtle
 * - cursor: 좌측 2px accent border
 * - selected: bg-active
 * - 28px 행 높이 (보통 모드)
 */
export function EntryRow({
  entry,
  isCursor,
  isSelected,
  splitExt,
  localPath,
  dirSize,
  renameRef,
  onRenameDone,
  onClick,
  onDoubleClick,
}: EntryRowProps) {
  // 합성 ".." 부모 행 — 아이콘 + ".." 만, 메타/선택 표시 없음.
  if (isParentEntry(entry)) {
    return (
      <div
        className={clsx(
          // h-full: 행 높이는 가상 스크롤 래퍼(밀도 설정 반영)가 결정.
          "flex h-full items-center gap-2 px-2 text-base cursor-default hover:bg-subtle",
          isCursor
            ? "border-l-2 border-l-accent pl-[6px]"
            : "border-l-2 border-l-transparent",
        )}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        title="Parent folder"
      >
        <FolderUp size={14} className="shrink-0 text-fg-muted" />
        <span className="font-mono flex-1 truncate text-fg-muted">..</span>
      </div>
    );
  }
  // 확장자 분리 모드면 이름에서 ext 를 떼어 별도 컬럼으로. 아니면 전체 이름 표시.
  const { stem, ext } = splitExt
    ? splitNameExt(entry.name, entry.kind === "dir")
    : { stem: entry.name, ext: "" };
  return (
    <div
      className={clsx(
        "flex h-full items-center gap-2 px-2 text-base cursor-default",
        // 선택된 행은 hover 로 회색(bg-subtle) 덮어쓰지 않음 — 마키 드래그 중
        // 포인터가 지나가도 파란 선택색 유지 (hover 변종이 specificity 로 이김).
        isSelected ? "bg-active" : "hover:bg-subtle",
        isCursor && "border-l-2 border-l-accent pl-[6px]",
        !isCursor && "border-l-2 border-l-transparent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {/* 드래그 핸들 = 아이콘+이름 (항목 이동). 우측 메타 컬럼은 마키 시작 영역. */}
      <span data-drag-handle className="flex min-w-0 flex-1 items-center gap-2">
        <EntryIcon entry={entry} size={14} localPath={localPath} />
        {renameRef && onRenameDone ? (
          <InlineRenameInput
            target={renameRef}
            isDir={entry.kind === "dir"}
            onDone={onRenameDone}
            className="flex-1 text-base"
          />
        ) : (
          <span
            className={clsx(
              "font-mono truncate",
              entry.hidden && "text-fg-muted",
            )}
          >
            {stem}
          </span>
        )}
      </span>
      {splitExt && (
        <span className="font-mono w-[var(--col-ext)] truncate text-meta text-fg-muted">
          {ext}
        </span>
      )}
      <span className="font-mono w-[var(--col-size)] text-right text-meta text-fg-muted">
        {formatSize(dirSize ?? entry.size)}
      </span>
      <span className="font-mono w-[var(--col-mtime)] text-right text-meta text-fg-muted">
        {formatTime(entry.modified_ms)}
      </span>
    </div>
  );
}
