import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RotateCw,
  Star,
  FileArchive,
  Pencil,
  Monitor,
  Server,
  BookMarked,
  Folder,
  Plus,
} from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import type { Location } from "@/types/bindings";

type Crumb = { label: string; path: string };

/**
 * 경로 → breadcrumb 조각. 소스에 맞는 구분자로 **클릭 시 이동할 절대경로**를 만든다.
 * - 원격(SSH): POSIX (`/`).
 * - 로컬 Windows: `\` (드라이브 루트 `C:\` 처리). 이게 없으면 `/`로 join 돼
 *   `/C:\...` 같은 깨진 경로 → OS error 13(EACCES). (CLAUDE.md §7 — 표시용 분기는
 *   소스 기준으로만, 실제 경로 결합은 여기 한 곳.)
 * 화면상 구분자는 시각적 `/` 로 통일하고, 실제 path 만 올바른 구분자를 쓴다.
 */
function buildCrumbs(path: string, winLocal: boolean): Crumb[] {
  const parts = pathSegments(path);
  const crumbs: Crumb[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (winLocal) {
      if (i === 0 && /^[A-Za-z]:$/.test(p)) acc = p + "\\";
      else acc = acc.endsWith("\\") ? acc + p : acc + "\\" + p;
    } else {
      acc = acc + "/" + p;
    }
    crumbs.push({ label: p, path: acc });
  }
  return crumbs;
}
import type { ArchiveBrowse } from "@/stores/panes";
import {
  useBookmarks,
  addBookmark,
  removeBookmark,
  sameBookmarkLocation,
} from "@/stores/bookmarks";
import { folderName } from "@/lib/entryMenu";
import { pathSegments } from "@/lib/paths";
import { useHostLabel } from "@/lib/hostLabel";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";

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
  /** 새 탭 열기 (Ctrl+T 와 동일). 탭이 1개여도 보이게 — 탭 기능 발견성용. */
  onNewTab?: () => void;
}

/**
 * 패널 상단 경로 표시 + 네비 버튼.
 * DESIGN.md "패널 헤더 (PathBar)" 참조.
 *
 * MVP-0: breadcrumb 표시 + 새로고침. 직접 입력 모드(Ctrl+L)는 추후.
 */
export function PathBar({
  location,
  archive,
  canBack,
  canForward,
  onBack,
  onForward,
  onUp,
  onRefresh,
  onSegmentClick,
  onUpdateArchive,
  editNonce,
  editActive,
  onNewTab,
}: PathBarProps) {
  const { t } = useTranslation();
  const isLocal = location.source.kind === "local";
  const sourceTitle = useHostLabel(location.source);
  const winLocal = isLocal && platform() === "windows";
  const crumbs = buildCrumbs(String(location.path), winLocal);

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
          .map((seg, i, arr) => ({
            label: seg,
            path: archive.root + "/" + arr.slice(0, i + 1).join("/"),
          }))
      : [];

  const bookmarkId = useBookmarks(
    (s) =>
      s.items.find((b) => sameBookmarkLocation(b.location, location))?.id ??
      null,
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

  // TC 식 즐겨찾기 드롭다운 — 현재 소스(local) 또는 현재 host(ssh)의 즐겨찾기를
  // 나열, 클릭 시 이동. 기존 ContextMenu 인프라 재사용(위치보정/키보드/바깥클릭).
  const openFavorites = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const src = location.source;
    const favs =
      src.kind === "local"
        ? useBookmarks
            .getState()
            .items.filter((b) => b.location.source.kind === "local")
            .map((b) => ({
              id: b.id,
              name: b.name,
              path: String(b.location.path),
            }))
        : useHostFavorites
            .getState()
            .items.filter(
              (f) => f.host_alias === (src.connection_id.split(":")[0] ?? ""),
            )
            .map((f) => ({ id: f.id, name: f.name, path: String(f.path) }));

    const list: MenuEntry[] =
      favs.length === 0
        ? [{ id: "empty", label: t("pathbar.noFavorites"), disabled: true }]
        : favs.map((f) => ({
            id: f.id,
            label: f.name,
            shortcut: f.path,
            icon: <Folder size={13} />,
            onSelect: () => onSegmentClick?.(f.path),
          }));

    const entries: MenuEntry[] = [
      {
        id: "add",
        label: bookmarked
          ? t("pathbar.removeThisFolder")
          : t("pathbar.addThisFolder"),
        icon: <Star size={13} />,
        onSelect: toggleBookmark,
      },
      { kind: "separator" },
      ...list,
    ];
    useContextMenu.getState().openAt(rect.left, rect.bottom + 4, entries);
  };

  return (
    <div className="flex h-8 items-center gap-1 border-b border-border bg-subtle px-2 text-base">
      <button
        type="button"
        onClick={onBack}
        disabled={!canBack}
        className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30"
        aria-label={t("pathbar.back")}
        title={t("pathbar.backTitle")}
      >
        <ArrowLeft size={14} />
      </button>
      <button
        type="button"
        onClick={onForward}
        disabled={!canForward}
        className="rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30"
        aria-label={t("pathbar.forward")}
        title={t("pathbar.forwardTitle")}
      >
        <ArrowRight size={14} />
      </button>
      <button
        onClick={onUp}
        className="rounded p-1 hover:bg-border"
        disabled={!onUp}
        aria-label={t("pathbar.up")}
      >
        <ArrowUp size={14} />
      </button>
      {archive ? (
        <div className="ml-2 flex items-center gap-0.5 font-mono truncate">
          <FileArchive size={13} className="mr-1 shrink-0 text-accent" />
          <button
            onClick={() => onSegmentClick?.(archive.root)}
            className="rounded px-1 hover:bg-border"
            title={t("pathbar.archiveReadOnlyTitle", { name: archive.label })}
          >
            {archive.label}
          </button>
          {archiveSegments.map((s) => (
            <span key={s.path} className="flex items-center">
              <span className="text-fg-muted">/</span>
              <button
                onClick={() => onSegmentClick?.(s.path)}
                className="rounded px-1 hover:bg-border"
              >
                {s.label}
              </button>
            </span>
          ))}
          {onUpdateArchive ? (
            <button
              onClick={onUpdateArchive}
              className="ml-1 shrink-0 rounded bg-accent/10 px-1.5 text-meta text-accent hover:bg-accent/20"
              title={t("pathbar.updateArchiveTitle")}
            >
              {t("pathbar.updateArchive")}
            </button>
          ) : (
            <span className="ml-1 shrink-0 rounded bg-subtle px-1 text-meta text-fg-muted">
              {t("pathbar.readOnly")}
            </span>
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
          placeholder={t("pathbar.pathPlaceholder")}
          aria-label={t("pathbar.goToPath")}
          className="ml-2 min-w-0 flex-1 rounded border border-accent bg-subtle px-2 py-0.5 font-mono text-base focus:outline-none"
        />
      ) : (
        <>
          <span
            title={sourceTitle}
            aria-label={sourceTitle}
            className="ml-2 flex shrink-0 items-center text-fg-muted"
          >
            {isLocal ? <Monitor size={14} /> : <Server size={14} />}
          </span>
          <div className="ml-1 flex items-center gap-0.5 font-mono truncate">
            {!winLocal && (
              <button
                onClick={() => onSegmentClick?.("/")}
                className="rounded px-1 hover:bg-border"
              >
                /
              </button>
            )}
            {crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center">
                <button
                  onClick={() => onSegmentClick?.(c.path)}
                  className="rounded px-1 hover:bg-border"
                >
                  {c.label}
                </button>
                {i < crumbs.length - 1 && (
                  <span className="text-fg-muted">/</span>
                )}
              </span>
            ))}
          </div>
        </>
      )}
      <div className="ml-auto flex items-center">
        {onNewTab && (
          <button
            onClick={onNewTab}
            className="rounded p-1 hover:bg-border"
            aria-label={t("tabs.newTab")}
            title={t("pathbar.newTabTitle")}
          >
            <Plus size={14} className="text-fg-muted" />
          </button>
        )}
        {!archive && !editing && (
          <button
            onClick={startEdit}
            className="rounded p-1 hover:bg-border"
            aria-label={t("pathbar.editPath")}
            title={t("pathbar.editPathTitle")}
          >
            <Pencil size={13} className="text-fg-muted" />
          </button>
        )}
        {/* 즐겨찾기 바로가기 드롭다운 (TC 식) — 이 host/소스의 저장 폴더로 이동 */}
        {!archive && (
          <button
            onClick={openFavorites}
            className="rounded p-1 hover:bg-border"
            aria-label={t("pathbar.favorites")}
            title={t("pathbar.favoritesTitle")}
          >
            <BookMarked size={14} className="text-fg-muted" />
          </button>
        )}
        {/* 아카이브 임시경로는 북마크하면 dangling 되므로 숨김 */}
        {!archive && (
          <button
            onClick={toggleBookmark}
            className="rounded p-1 hover:bg-border"
            aria-label={
              bookmarked
                ? t("sidebar.removeBookmark")
                : t("pathbar.bookmarkThisFolder")
            }
            title={
              bookmarked
                ? t("pathbar.bookmarkedTitle")
                : t("pathbar.bookmarkTitle")
            }
          >
            <Star
              size={14}
              className={bookmarked ? "text-accent" : "text-fg-muted"}
              fill={bookmarked ? "currentColor" : "none"}
            />
          </button>
        )}
        <button
          onClick={onRefresh}
          className="rounded p-1 hover:bg-border"
          aria-label={t("menu.refresh")}
        >
          <RotateCw size={14} />
        </button>
      </div>
    </div>
  );
}
