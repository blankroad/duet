import { ArrowLeft, ArrowRight, ArrowUp, RotateCw, Star, FileArchive } from "lucide-react";
import type { Location } from "@/types/bindings";
import type { ArchiveBrowse } from "@/stores/panes";
import {
  useBookmarks,
  addBookmark,
  removeBookmark,
  sameBookmarkLocation,
} from "@/stores/bookmarks";
import { folderName } from "@/lib/entryMenu";
import { bookmarkLocation } from "@/lib/bookmarkActions";

interface PathBarProps {
  location: Location;
  /** 아카이브 내부 탐색 중이면 set — breadcrumb 를 archive.zip/sub 로 표시. */
  archive?: ArchiveBrowse | undefined;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp?: () => void;
  onRefresh?: () => void;
  onSegmentClick?: (path: string) => void;
}

/**
 * 패널 상단 경로 표시 + 네비 버튼.
 * DESIGN.md "패널 헤더 (PathBar)" 참조.
 *
 * MVP-0: breadcrumb 표시 + 새로고침. 직접 입력 모드(Ctrl+L)는 추후.
 */
export function PathBar({ location, archive, canBack, canForward, onBack, onForward, onUp, onRefresh, onSegmentClick }: PathBarProps) {
  const sourceLabel = location.source.kind === "local" ? "Local" : `${location.source.user}@${location.source.host_ip}`;
  const segments = location.path.split("/").filter(Boolean);

  // 아카이브 내부: 임시경로 대신 archive.zip/sub 상대 breadcrumb.
  const archiveSegments =
    archive && location.path.startsWith(archive.root)
      ? location.path
          .slice(archive.root.length)
          .split("/")
          .filter(Boolean)
          .map((seg, i, arr) => ({ label: seg, path: archive.root + "/" + arr.slice(0, i + 1).join("/") }))
      : [];

  const bookmarkId = useBookmarks(
    (s) => s.items.find((b) => sameBookmarkLocation(b.location, location))?.id ?? null,
  );
  const bookmarked = bookmarkId !== null;
  const toggleBookmark = () => {
    if (location.source.kind === "ssh") {
      void bookmarkLocation(location, folderName(location));
      return;
    }
    if (bookmarkId) void removeBookmark(bookmarkId);
    else void addBookmark(folderName(location), location);
  };

  return (
    <div className="flex h-8 items-center gap-1 border-b border-border bg-subtle px-2 text-base">
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30"
        aria-label="Back"
        title="Back (Alt+←)"
      >
        <ArrowLeft size={12} />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canForward}
        className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30"
        aria-label="Forward"
        title="Forward (Alt+→)"
      >
        <ArrowRight size={12} />
      </button>
      <button onClick={onUp} className="rounded p-1 hover:bg-border" disabled={!onUp} aria-label="Up">
        <ArrowUp size={14} />
      </button>
      {archive ? (
        <div className="ml-2 flex items-center gap-0.5 font-mono truncate">
          <FileArchive size={13} className="mr-1 shrink-0 text-accent" />
          <button
            onClick={() => onSegmentClick?.(archive.root)}
            className="rounded px-1 hover:bg-border"
            title={`${archive.label} (read-only)`}
          >
            {archive.label}
          </button>
          {archiveSegments.map((s) => (
            <span key={s.path} className="flex items-center">
              <span className="text-fg-muted">/</span>
              <button onClick={() => onSegmentClick?.(s.path)} className="rounded px-1 hover:bg-border">
                {s.label}
              </button>
            </span>
          ))}
          <span className="ml-1 shrink-0 rounded bg-subtle px-1 text-meta text-fg-muted">read-only</span>
        </div>
      ) : (
        <>
          <span className="ml-2 font-mono truncate text-fg-muted">{sourceLabel}</span>
          <span className="text-fg-muted">:</span>
          <div className="flex items-center gap-0.5 font-mono truncate">
            <button onClick={() => onSegmentClick?.("/")} className="rounded px-1 hover:bg-border">
              /
            </button>
            {segments.map((seg, i) => {
              const cumulative = "/" + segments.slice(0, i + 1).join("/");
              return (
                <span key={cumulative} className="flex items-center">
                  <button
                    onClick={() => onSegmentClick?.(cumulative)}
                    className="rounded px-1 hover:bg-border"
                  >
                    {seg}
                  </button>
                  {i < segments.length - 1 && <span className="text-fg-muted">/</span>}
                </span>
              );
            })}
          </div>
        </>
      )}
      <div className="ml-auto flex items-center">
        {/* 아카이브 임시경로는 북마크하면 dangling 되므로 숨김 */}
        {!archive && (
          <button
            onClick={toggleBookmark}
            className="rounded p-1 hover:bg-border"
            aria-label={bookmarked ? "Remove bookmark" : "Bookmark this folder"}
            title={bookmarked ? "Bookmarked (Ctrl+D)" : "Bookmark this folder (Ctrl+D)"}
          >
            <Star
              size={14}
              className={bookmarked ? "text-accent" : "text-fg-muted"}
              fill={bookmarked ? "currentColor" : "none"}
            />
          </button>
        )}
        <button onClick={onRefresh} className="rounded p-1 hover:bg-border" aria-label="Refresh">
          <RotateCw size={14} />
        </button>
      </div>
    </div>
  );
}
