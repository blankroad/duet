import { PathBreadcrumbs } from "./PathBreadcrumbs";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useKeyHint } from "@/lib/keyHint";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RotateCw,
  Star,
  FileArchive,
  Pencil,
  BookMarked,
  Folder,
  Plus,
  Trash2,
  Copy,
} from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import { commands, type Location } from "@/types/bindings";

import type { ArchiveBrowse } from "@/stores/panes";
import {
  useBookmarks,
  addBookmark,
  removeBookmark,
  sameBookmarkLocation,
} from "@/stores/bookmarks";
import { folderName } from "@/lib/entryMenu";
import { archiveCrumbs, buildCrumbs } from "./pathCrumbs";
import { SourceChip } from "./SourceIndicator";
import { aliasFromConnectionId } from "@/lib/hostAlias";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import { useHostFavorites, removeHostFavorite } from "@/stores/hostFavorites";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { useToast } from "@/stores/toast";

/** 경로 바 아이콘 버튼 — 24px 타깃, muted 아이콘, accent 포커스 링(도구 모음과 같은 어휘). */
const NAV_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-fg-muted hover:bg-border hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

interface PathBarProps {
  location: Location;
  /** 아카이브 내부 탐색 중이면 set — breadcrumb 를 archive.zip/sub 로 표시. */
  archive?: ArchiveBrowse | undefined;
  /** 가상 휴지통 뷰 — breadcrumb 대신 "휴지통" 라벨. */
  trash?: boolean | undefined;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp?: () => void;
  /** 위로 갈 곳이 있는가 — 루트에서는 버튼이 눌리는 것처럼 보이면 안 된다. */
  canUp?: boolean;
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
 * 현재 폴더 이름 클릭·연필·Ctrl+L 로 경로 직접 입력, `…` 로 상위 폴더 이동.
 */
export function PathBar({
  location,
  archive,
  trash,
  canBack,
  canForward,
  onBack,
  onForward,
  onUp,
  canUp = true,
  onRefresh,
  onSegmentClick,
  onUpdateArchive,
  editNonce,
  editActive,
  onNewTab,
}: PathBarProps) {
  const kEditPath = useKeyHint("pane.editPath");
  const kBookmark = useKeyHint("bookmark.toggle");
  const kBack = useKeyHint("nav.back");
  const kForward = useKeyHint("nav.forward");
  const kNewTab = useKeyHint("tab.new");
  const kRefresh = useKeyHint("view.refresh");
  const { t } = useTranslation();
  const isLocal = location.source.kind === "local";
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
    if (editActive && !archive && !trash) startEdit();
    // editNonce 증가만 트리거 (location 변경으로 재실행 안 함).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editNonce]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const submitPath = () => {
    const raw = draft;
    setEditing(false);
    if (!raw.trim()) return;
    // 붙여 넣은 경로 정리(탐색기 "경로로 복사"의 따옴표 등)는 백엔드 platform 이 한다(§7).
    void commands.pathParseInput(raw, isLocal).then((r) => {
      const p = r.status === "ok" ? r.data : raw.trim();
      if (p) onSegmentClick?.(p);
    });
  };

  // 현재 폴더 경로 복사 — 항목 경로 복사(copyPathsOf)와 같은 형식(`/` 통일).
  const copyCurrentPath = () => {
    const toast = useToast.getState().show;
    void navigator.clipboard
      .writeText(String(location.path).replace(/\\/g, "/"))
      .then(
        () =>
          toast(
            t("toast.copiedLabel", {
              label: t("toast.labelPath").toLowerCase(),
            }),
            "success",
          ),
        () => toast(t("toast.clipboardUnavailable"), "error"),
      );
  };
  const copyPathItem: MenuEntry = {
    id: "copy-path",
    label: t("menu.copyPath"),
    icon: <Copy size={13} />,
    onSelect: copyCurrentPath,
  };
  const openCurrentMenu = (e: React.MouseEvent) => {
    useContextMenu.getState().openAt(e.clientX, e.clientY, [
      copyPathItem,
      {
        id: "edit-path",
        label: t("pathbar.editPath"),
        icon: <Pencil size={13} />,
        commandId: "pane.editPath",
        onSelect: startEdit,
      },
    ]);
  };

  // 아카이브 내부: 임시경로 대신 archive.zip/sub 상대 breadcrumb.
  const archiveSegments = archive
    ? archiveCrumbs(String(location.path), archive.root, winLocal)
    : [];

  // 로컬은 북마크, 원격은 호스트 즐겨찾기 — 두 저장소가 나뉘어 있어도 ★ 하나로
  // 같은 의미(이 폴더가 저장돼 있나 / 토글)를 갖는다. 예전엔 원격에서 ★ 이 절대
  // 채워지지 않고 누를 때마다 즐겨찾기가 하나씩 더 생겼다.
  const hostAlias =
    location.source.kind === "ssh"
      ? aliasFromConnectionId(location.source.connection_id)
      : null;
  const localBookmarkId = useBookmarks((s) =>
    hostAlias !== null
      ? null
      : (s.items.find((b) => sameBookmarkLocation(b.location, location))?.id ??
        null),
  );
  const favoriteId = useHostFavorites((s) =>
    hostAlias === null
      ? null
      : (s.items.find(
          (f) =>
            f.host_alias === hostAlias &&
            String(f.path) === String(location.path),
        )?.id ?? null),
  );
  const bookmarkId = hostAlias === null ? localBookmarkId : favoriteId;
  const bookmarked = bookmarkId !== null;
  const toggleBookmark = () => {
    if (hostAlias !== null) {
      if (favoriteId) void removeHostFavorite(favoriteId);
      else void bookmarkLocation(location, folderName(location));
      return;
    }
    if (localBookmarkId) void removeBookmark(localBookmarkId);
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
              (f) => f.host_alias === aliasFromConnectionId(src.connection_id),
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
    <div className="path-bar grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1 border-b border-border bg-subtle px-1 text-base">
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          onClick={onBack}
          disabled={!canBack}
          className={NAV_BUTTON}
          aria-label={t("pathbar.back")}
          title={t("pathbar.backTitle", { key: kBack })}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!canForward}
          className={NAV_BUTTON}
          aria-label={t("pathbar.forward")}
          title={t("pathbar.forwardTitle", { key: kForward })}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          onClick={onUp}
          className={NAV_BUTTON}
          disabled={!onUp || !canUp}
          aria-label={t("pathbar.up")}
          title={t("pathbar.upTitle")}
        >
          <ArrowUp size={14} />
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        {/* 소스 칩 — 원격이면 호스트 이름과 연결 상태. 어느 화면(편집·아카이브·
            휴지통)에서도 숨기지 않는다: 탭이 1개면 이것이 유일한 원격 단서다. */}
        <SourceChip source={location.source} />
        {trash ? (
          <div className="ml-2 flex min-w-0 items-center gap-1.5 truncate">
            <Trash2 size={13} className="shrink-0 text-fg-muted" />
            <span className="text-base text-fg">{t("pathbar.trash")}</span>
          </div>
        ) : archive ? (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono">
            <FileArchive size={13} className="mr-1 shrink-0 text-accent" />
            <PathBreadcrumbs
              showPaths={false}
              items={[
                { label: archive.label, path: archive.root },
                ...archiveSegments,
              ]}
              onNavigate={onSegmentClick}
            />
            {onUpdateArchive ? (
              <button
                type="button"
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
          // 소스(로컬/원격) 표시는 위의 SourceChip 이 담당 (tabs 팀) — 여기는 경로만.
          <PathBreadcrumbs
            items={winLocal ? crumbs : [{ label: "/", path: "/" }, ...crumbs]}
            onNavigate={onSegmentClick}
            // 현재 폴더 이름 클릭 = 경로 직접 입력 (탐색기 주소창 관례).
            onCurrentClick={startEdit}
            currentTitle={t("pathbar.currentTitle", {
              path: String(location.path),
            })}
            menuHead={[copyPathItem, { kind: "separator" }]}
            onCurrentContextMenu={openCurrentMenu}
          />
        )}
      </div>
      <div className="path-actions ml-auto flex shrink-0 items-center">
        {onNewTab && (
          <button
            type="button"
            onClick={onNewTab}
            className={NAV_BUTTON}
            aria-label={t("tabs.newTab")}
            title={t("pathbar.newTabTitle", { key: kNewTab })}
          >
            <Plus size={14} />
          </button>
        )}
        {!archive && !trash && !editing && (
          <button
            type="button"
            onClick={startEdit}
            className={NAV_BUTTON}
            aria-label={t("pathbar.editPath")}
            title={t("pathbar.editPathTitle", { key: kEditPath })}
          >
            <Pencil size={13} />
          </button>
        )}
        {/* 즐겨찾기 바로가기 드롭다운 (TC 식) — 이 host/소스의 저장 폴더로 이동 */}
        {!archive && (
          <button
            type="button"
            onClick={openFavorites}
            className={NAV_BUTTON}
            aria-label={t("pathbar.favorites")}
            title={t("pathbar.favoritesTitle")}
          >
            <BookMarked size={14} />
          </button>
        )}
        {/* 아카이브 임시경로는 북마크하면 dangling 되므로 숨김 */}
        {!archive && (
          <button
            type="button"
            onClick={toggleBookmark}
            className={NAV_BUTTON}
            aria-label={
              bookmarked
                ? t("sidebar.removeBookmark")
                : t("pathbar.bookmarkThisFolder")
            }
            title={
              bookmarked
                ? t("pathbar.bookmarkedTitle", { key: kBookmark })
                : t("pathbar.bookmarkTitle", { key: kBookmark })
            }
          >
            <Star
              size={14}
              className={bookmarked ? "text-accent" : undefined}
              fill={bookmarked ? "currentColor" : "none"}
            />
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          className={NAV_BUTTON}
          aria-label={t("menu.refresh")}
          title={t("pathbar.refreshTitle", { key: kRefresh })}
        >
          <RotateCw size={14} />
        </button>
      </div>
    </div>
  );
}
