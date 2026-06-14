import {
  Folder,
  Server,
  Star,
  Network,
  Plus,
  X,
  Bookmark,
  Heart,
  ChevronDown,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { useUI } from "@/stores/ui";
import { useConnections, type Host, type ConnectionState } from "@/stores/connections";
import { useSavedHosts, removeSavedHost, reorderSavedHosts } from "@/stores/savedHosts";
import { useBookmarks, removeBookmark, reorderBookmarks } from "@/stores/bookmarks";
import {
  useHostFavorites,
  removeHostFavorite,
  reorderHostFavorites,
} from "@/stores/hostFavorites";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { useToast } from "@/stores/toast";
import { useReorderable } from "@/hooks/useReorderable";
import type { SavedHost, Bookmark as BookmarkType, HostFavorite, Location } from "@/types/bindings";
import clsx from "clsx";
import { Fragment, type ReactNode } from "react";

/**
 * 사이드바.
 *
 * - 섹션 헤더 클릭으로 접기/펼치기(상태 영속), 제목 옆 항목 수 표시, 전체 세로 스크롤.
 * - 항목 우클릭 → 컨텍스트 메뉴(Open/Connect/Remove 등).
 * - Bookmarks / Saved hosts / Favorites(그룹 내) 는 드래그로 순서 변경.
 *
 * - Local: home (MVP-0 placeholder)
 * - Hosts: `~/.ssh/config` 호스트 + 연결 상태 점 + ad-hoc. (읽기전용 — 재정렬 X)
 * - Saved hosts: ad-hoc dialog 에서 저장한 호스트. 더블클릭 → prefill 다이얼로그.
 * - Bookmarks: 북마크한 위치(로컬/SSH). 더블클릭 → 이동.
 * - Favorites: 활성 SSH 연결의 호스트별 즐겨찾기 경로. alias 별 그룹화 + 그룹 접기.
 */
export function Sidebar({
  onHostActivate,
  onAdHocOpen,
  onSavedActivate,
  onBookmarkActivate,
  onFavoriteActivate,
  onAddBookmark,
  onAddFavorite,
  onTrashActivate,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
  onSavedActivate: (host: SavedHost) => void;
  onBookmarkActivate: (location: Location) => void;
  onFavoriteActivate: (favorite: HostFavorite) => void;
  onAddBookmark: () => void;
  onAddFavorite: () => void;
  /** 활성 패널을 그 소스의 휴지통으로 이동 (삭제 항목 보기/복구). */
  onTrashActivate: () => void;
}) {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 min-h-0 flex-col overflow-y-auto border-r border-border bg-subtle text-base">
      <Section sectionKey="local" title="Local" icon={<Folder size={14} />}>
        <Item label="Home" />
        <button
          type="button"
          onClick={onTrashActivate}
          className={clsx(rowClass, "w-full text-left")}
          title="Browse trash (deleted items)"
        >
          <Trash2 size={11} className="shrink-0 text-fg-muted" />
          <span className="truncate">Trash</span>
        </button>
      </Section>
      <HostsSection onHostActivate={onHostActivate} onAdHocOpen={onAdHocOpen} />
      <SavedHostsSection onActivate={onSavedActivate} />
      <BookmarksSection onActivate={onBookmarkActivate} onAdd={onAddBookmark} />
      <HostFavoritesSection onActivate={onFavoriteActivate} onAdd={onAddFavorite} />
    </aside>
  );
}

/** 컨텍스트 메뉴 오픈 헬퍼. */
function openMenu(e: React.MouseEvent, items: MenuEntry[]): void {
  e.preventDefault();
  e.stopPropagation();
  useContextMenu.getState().openAt(e.clientX, e.clientY, items);
}

/** 클립보드 복사 + 토스트. */
function copyText(text: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => useToast.getState().show(`Copied: ${text}`))
    .catch(() => useToast.getState().show("Clipboard unavailable"));
}

/** 드래그 삽입 위치 표시 라인. */
function DropLine() {
  return <div className="mx-2 my-0.5 h-0.5 rounded bg-accent" />;
}

const rowClass = "group flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border";

// ─────────────────────────── Saved hosts ───────────────────────────

function SavedHostsSection({ onActivate }: { onActivate: (host: SavedHost) => void }) {
  const hosts = useSavedHosts((s) => s.hosts);
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group: "saved",
    keys: hosts.map((h) => h.alias),
    onCommit: (next) => void reorderSavedHosts(next),
  });
  return (
    <Section sectionKey="saved" title="Saved hosts" icon={<Bookmark size={14} />} count={hosts.length}>
      {hosts.length === 0 ? (
        <Item label="(none — Save host on connect)" muted />
      ) : (
        hosts.map((h) => (
          <Fragment key={h.alias}>
            {dragKey && insertBeforeKey === h.alias && <DropLine />}
            <SavedHostItem
              host={h}
              onActivate={onActivate}
              dragging={dragKey === h.alias}
              onMouseDown={(e) => onItemMouseDown(e, h.alias)}
            />
          </Fragment>
        ))
      )}
      {dragKey && insertBeforeKey === null && <DropLine />}
    </Section>
  );
}

function SavedHostItem({
  host,
  onActivate,
  dragging,
  onMouseDown,
}: {
  host: SavedHost;
  onActivate: (host: SavedHost) => void;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const menu: MenuEntry[] = [
    { id: "connect", label: "Connect / Edit…", onSelect: () => onActivate(host) },
    { kind: "separator" },
    { id: "remove", label: "Remove", danger: true, onSelect: () => void removeSavedHost(host.alias) },
  ];
  return (
    <div
      data-reorder-key={host.alias}
      data-reorder-group="saved"
      onMouseDown={onMouseDown}
      onDoubleClick={() => onActivate(host)}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${host.user}@${host.host}:${host.port}${host.key_path ? ` (key: ${host.key_path})` : ""}`}
      className={clsx(rowClass, dragging && "opacity-50")}
    >
      <Bookmark size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{host.alias}</span>
      <DeleteBtn label={`Remove saved host ${host.alias}`} onClick={() => void removeSavedHost(host.alias)} />
    </div>
  );
}

// ─────────────────────────── Bookmarks ───────────────────────────

function BookmarksSection({
  onActivate,
  onAdd,
}: {
  onActivate: (location: Location) => void;
  onAdd: () => void;
}) {
  const items = useBookmarks((s) => s.items);
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group: "bookmarks",
    keys: items.map((b) => b.id),
    onCommit: (next) => void reorderBookmarks(next),
  });
  return (
    <Section
      sectionKey="bookmarks"
      title="Bookmarks"
      icon={<Star size={14} />}
      count={items.length}
      action={<AddBtn label="Add active tab to bookmarks" onClick={onAdd} />}
    >
      {items.length === 0 ? (
        <Item label="(none — + to add active tab)" muted />
      ) : (
        items.map((b) => (
          <Fragment key={b.id}>
            {dragKey && insertBeforeKey === b.id && <DropLine />}
            <BookmarkItem
              bookmark={b}
              onActivate={onActivate}
              dragging={dragKey === b.id}
              onMouseDown={(e) => onItemMouseDown(e, b.id)}
            />
          </Fragment>
        ))
      )}
      {dragKey && insertBeforeKey === null && <DropLine />}
    </Section>
  );
}

function BookmarkItem({
  bookmark,
  onActivate,
  dragging,
  onMouseDown,
}: {
  bookmark: BookmarkType;
  onActivate: (location: Location) => void;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const sshPrefix = bookmark.location.source.kind === "ssh" ? "ssh:" : "";
  const menu: MenuEntry[] = [
    { id: "open", label: "Open", onSelect: () => onActivate(bookmark.location) },
    { id: "copy-path", label: "Copy path", onSelect: () => copyText(String(bookmark.location.path)) },
    { kind: "separator" },
    { id: "remove", label: "Remove", danger: true, onSelect: () => void removeBookmark(bookmark.id) },
  ];
  return (
    <div
      data-reorder-key={bookmark.id}
      data-reorder-group="bookmarks"
      onMouseDown={onMouseDown}
      onDoubleClick={() => onActivate(bookmark.location)}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${sshPrefix}${bookmark.location.path}`}
      className={clsx(rowClass, dragging && "opacity-50")}
    >
      <Star size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{bookmark.name}</span>
      <DeleteBtn label="Remove bookmark" onClick={() => void removeBookmark(bookmark.id)} />
    </div>
  );
}

// ─────────────────────────── Host favorites ───────────────────────────

function HostFavoritesSection({
  onActivate,
  onAdd,
}: {
  onActivate: (favorite: HostFavorite) => void;
  onAdd: () => void;
}) {
  const items = useHostFavorites((s) => s.items);
  const activeRecord = useConnections((s) => s.active);
  const activeAliases = new Set(Object.values(activeRecord).map((c) => c.alias));
  // 모든 즐겨찾기 표시(연결 안 돼도) — 클릭 시 자동 접속, 어디서나 관리/삭제 가능.
  const groups: Record<string, HostFavorite[]> = {};
  for (const f of items) (groups[f.host_alias] ??= []).push(f);
  const groupKeys = Object.keys(groups).sort();

  return (
    <Section
      sectionKey="favorites"
      title="Favorites"
      icon={<Heart size={14} />}
      count={items.length}
      action={<AddBtn label="Add active tab path (SSH only)" onClick={onAdd} />}
    >
      {groupKeys.length === 0 ? (
        <Item label="(none — bookmark an SSH folder)" muted />
      ) : (
        groupKeys.map((alias) => (
          <FavoriteGroup
            key={alias}
            alias={alias}
            favs={groups[alias]!}
            connected={activeAliases.has(alias)}
            onActivate={onActivate}
          />
        ))
      )}
    </Section>
  );
}

function FavoriteGroup({
  alias,
  favs,
  connected,
  onActivate,
}: {
  alias: string;
  favs: HostFavorite[];
  connected: boolean;
  onActivate: (favorite: HostFavorite) => void;
}) {
  const collapsed = useUI((s) => s.collapsed[`fav:${alias}`]);
  const toggle = useUI((s) => s.toggleSection);
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group: `fav:${alias}`,
    keys: favs.map((f) => f.id),
    onCommit: (next) => void reorderHostFavorites(next),
  });
  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(`fav:${alias}`)}
        className="flex w-full items-center gap-1 px-2 text-meta text-fg-muted hover:text-fg"
        title={connected ? `${alias} (connected)` : `${alias} (click an item to connect)`}
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        <span
          className={clsx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            connected ? "bg-green-500" : "bg-fg-muted/30",
          )}
        />
        <span className="truncate">{alias}</span>
        {collapsed && <span className="ml-auto opacity-50">{favs.length}</span>}
      </button>
      {!collapsed &&
        favs.map((f) => (
          <Fragment key={f.id}>
            {dragKey && insertBeforeKey === f.id && <DropLine />}
            <FavoriteItem
              fav={f}
              onActivate={onActivate}
              dragging={dragKey === f.id}
              onMouseDown={(e) => onItemMouseDown(e, f.id)}
            />
          </Fragment>
        ))}
      {!collapsed && dragKey && insertBeforeKey === null && <DropLine />}
    </div>
  );
}

function FavoriteItem({
  fav,
  onActivate,
  dragging,
  onMouseDown,
}: {
  fav: HostFavorite;
  onActivate: (favorite: HostFavorite) => void;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const menu: MenuEntry[] = [
    { id: "open", label: "Open (connect if needed)", onSelect: () => onActivate(fav) },
    { id: "copy-path", label: "Copy path", onSelect: () => copyText(String(fav.path)) },
    { kind: "separator" },
    { id: "remove", label: "Remove", danger: true, onSelect: () => void removeHostFavorite(fav.id) },
  ];
  return (
    <div
      data-reorder-key={fav.id}
      data-reorder-group={`fav:${fav.host_alias}`}
      onMouseDown={onMouseDown}
      onDoubleClick={() => onActivate(fav)}
      onContextMenu={(e) => openMenu(e, menu)}
      title={String(fav.path)}
      className={clsx(rowClass, "pl-4", dragging && "opacity-50")}
    >
      <Heart size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{fav.name}</span>
      <DeleteBtn label="Remove favorite" onClick={() => void removeHostFavorite(fav.id)} />
    </div>
  );
}

// ─────────────────────────── Hosts (read-only) ───────────────────────────

function HostsSection({
  onHostActivate,
  onAdHocOpen,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
}) {
  const hosts = useConnections((s) => s.hosts);
  const stateByAlias = useConnections((s) => s.stateByAlias)();

  return (
    <Section
      sectionKey="hosts"
      title="Hosts"
      icon={<Server size={14} />}
      count={hosts.length}
      action={<AddBtn label="Connect to host…" onClick={onAdHocOpen} />}
    >
      {hosts.length === 0 ? (
        <Item label="(no hosts in ~/.ssh/config)" muted />
      ) : (
        hosts.map((h) => (
          <HostItem
            key={h.alias}
            host={h}
            state={stateByAlias[h.alias] ?? { kind: "disconnected" }}
            onActivate={() => onHostActivate(h.alias)}
          />
        ))
      )}
    </Section>
  );
}

function HostItem({
  host,
  state,
  onActivate,
}: {
  host: Host;
  state: ConnectionState;
  onActivate: () => void;
}) {
  const menu: MenuEntry[] = [{ id: "connect", label: "Connect…", onSelect: onActivate }];
  return (
    <div
      onDoubleClick={onActivate}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${host.user}@${host.hostname}:${host.port}${host.has_proxy_jump ? " (via jump)" : ""}`}
      className="flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
    >
      <StateDot state={state} />
      <span className="truncate">{host.alias}</span>
      {host.has_proxy_jump && (
        <Network size={11} className="ml-auto shrink-0 text-fg-muted" aria-label="ProxyJump" />
      )}
    </div>
  );
}

function StateDot({ state }: { state: ConnectionState }) {
  const cls = {
    connected: "bg-green-500",
    connecting: "bg-yellow-500 animate-pulse",
    error: "bg-red-500",
    disconnected: "bg-fg-muted/30",
  }[state.kind];
  const label = state.kind === "error" ? state.message : state.kind;
  return <span aria-label={label} className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", cls)} />;
}

// ─────────────────────────── Shared building blocks ───────────────────────────

/** 접기 가능한 섹션 — 헤더 클릭으로 토글, 제목 옆 카운트, 선택적 action 버튼. */
function Section({
  sectionKey,
  title,
  icon,
  count,
  action,
  children,
}: {
  sectionKey: string;
  title: string;
  icon: ReactNode;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const collapsed = useUI((s) => s.collapsed[sectionKey]);
  const toggle = useUI((s) => s.toggleSection);
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center justify-between gap-1 text-meta text-fg-muted">
        <button
          type="button"
          onClick={() => toggle(sectionKey)}
          className="flex min-w-0 flex-1 items-center gap-1 hover:text-fg"
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          {icon}
          <span className="truncate">{title}</span>
          {/* 접혔을 때만 개수 표시 — 펼치면 항목이 보이니 중복 제거. */}
          {collapsed && count !== undefined && count > 0 && (
            <span className="ml-auto text-meta opacity-50">{count}</span>
          )}
        </button>
        {action}
      </div>
      {!collapsed && <div className="mt-1">{children}</div>}
    </div>
  );
}

/** 삭제(X) 버튼 — hover 시 노출. */
function DeleteBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
      aria-label={label}
      title="Remove"
    >
      <X size={11} />
    </button>
  );
}

/** 섹션 헤더의 + 추가 버튼. */
function AddBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
      aria-label={label}
      title={label}
    >
      <Plus size={11} />
    </button>
  );
}

function Item({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div className={clsx("rounded px-2 py-0.5 hover:bg-border", muted && "text-fg-muted")}>
      {label}
    </div>
  );
}
