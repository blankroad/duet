import type { Entry } from "@/types/bindings";
import { formatSize, formatTime } from "@/lib/format";
import { EntryIcon } from "@/lib/fileIcon";
import clsx from "clsx";

interface EntryRowProps {
  entry: Entry;
  isCursor: boolean;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

/**
 * DESIGN.md "행 (EntryRow)" 디자인.
 * - hover: bg-subtle
 * - cursor: 좌측 2px accent border
 * - selected: bg-active
 * - 28px 행 높이 (보통 모드)
 */
export function EntryRow({ entry, isCursor, isSelected, onClick, onDoubleClick }: EntryRowProps) {
  return (
    <div
      className={clsx(
        "flex h-7 items-center gap-2 px-2 text-base cursor-default",
        // 선택된 행은 hover 로 회색(bg-subtle) 덮어쓰지 않음 — 마키 드래그 중
        // 포인터가 지나가도 파란 선택색 유지 (hover 변종이 specificity 로 이김).
        isSelected ? "bg-active" : "hover:bg-subtle",
        isCursor && "border-l-2 border-l-accent pl-[6px]",
        !isCursor && "border-l-2 border-l-transparent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <EntryIcon entry={entry} size={14} />
      <span className={clsx("font-mono flex-1 truncate", entry.hidden && "text-fg-muted")}>
        {entry.name}
      </span>
      <span className="font-mono w-20 text-right text-meta text-fg-muted">{formatSize(entry.size)}</span>
      <span className="font-mono w-20 text-right text-meta text-fg-muted">{formatTime(entry.modified_ms)}</span>
    </div>
  );
}
