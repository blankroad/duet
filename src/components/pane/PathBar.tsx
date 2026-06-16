import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, RotateCw, Star, FileArchive, Pencil } from "lucide-react";
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
  /** 아카이브 browse 중 "Update archive" — 편집을 원본 아카이브로 repack. */
  onUpdateArchive?: (() => void) | undefined;
  /** Ctrl+L 신호 — nonce 증가 시 editActive 인 PathBar 가 경로 입력 모드로. */
  editNonce?: number;
  editActive?: boolean;
}

/**
 * 패널 상단 경로 표시 + 네비 버튼.
 * DESIGN.md "패널 헤더 (PathBar)" 참조.
 *
 * MVP-0: breadcrumb 표시 + 새로고침. 직접 입력 모드(Ctrl+L)는 추후.
 */
export function PathBar({ location, archive, canBack, canForward, onBack, onForward, onUp, onRefresh, onSegmentClick, onUpdateArchive, editNonce, editActive }: PathBarProps) {
  const sourceLabel = location.source.kind === "local" ? "Local" : `${location.source.user}@${location.source.host_ip}`;
  const segments = location.path.split("/").filter(Boolean);

  // 경로 직접 입력 모드 (탐색기 주소창 / Ctrl+L). 아카이브 임시경로에선 비활성.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const startEdit = () => {
    setDraft(String(location.path));
    setEditing(true);
  };
  // Ctrl+L 신호 — 이 패널이 대상(editActive)이면 편집 진입.
  useEffect(() => {
    if (editActive && !archive) startEdit();
    // editNonce 증가만 트리거 (location 변경으로 재실행 안 함).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editNonce]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const submitPath = () => {
    const p = draft.trim();
    setEditing(false);
    if (p) onSegmentClick?.(p);
  };

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
          {onUpdateArchive ? (
            <button
              onClick={onUpdateArchive}
              className="ml-1 shrink-0 rounded bg-accent/10 px-1.5 text-meta text-accent hover:bg-accent/20"
              title="Repack your edits back into the archive (previous version kept as .bak — undoable)"
            >
              Update archive
            </button>
          ) : (
            <span className="ml-1 shrink-0 rounded bg-subtle px-1 text-meta text-fg-muted">read-only</span>
          )}
        </div>
      ) : editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitPath();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={() => setEditing(false)}
          spellCheck={false}
          placeholder="Type a path and press Enter…"
          aria-label="Go to path"
          className="ml-2 min-w-0 flex-1 rounded border border-accent bg-subtle px-2 py-0.5 font-mono text-base focus:outline-none"
        />
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
        {!archive && !editing && (
          <button
            onClick={startEdit}
            className="rounded p-1 hover:bg-border"
            aria-label="Edit path"
            title="Edit path / go to location (Ctrl+L)"
          >
            <Pencil size={13} className="text-fg-muted" />
          </button>
        )}
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
