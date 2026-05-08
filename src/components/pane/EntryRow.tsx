import { Folder, File, Link as LinkIcon } from "lucide-react";
import type { Entry } from "@/types/bindings";
import { formatSize, formatTime } from "@/lib/format";
import clsx from "clsx";

interface EntryRowProps {
  entry: Entry;
  isCursor: boolean;
  isSelected: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
}

const iconFor = (entry: Entry) => {
  switch (entry.kind) {
    case "dir":
      return <Folder size={14} className="text-accent" />;
    case "symlink":
      return <LinkIcon size={14} className="text-fg-muted" />;
    default:
      return <File size={14} className="text-fg-muted" />;
  }
};

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
        "hover:bg-subtle",
        isSelected && "bg-active",
        isCursor && "border-l-2 border-l-accent pl-[6px]",
        !isCursor && "border-l-2 border-l-transparent",
      )}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {iconFor(entry)}
      <span className={clsx("font-mono flex-1 truncate", entry.hidden && "text-fg-muted")}>
        {entry.name}
      </span>
      <span className="font-mono w-20 text-right text-meta text-fg-muted">{formatSize(entry.size)}</span>
      <span className="font-mono w-20 text-right text-meta text-fg-muted">{formatTime(entry.modified_ms)}</span>
    </div>
  );
}
