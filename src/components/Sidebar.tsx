import { Folder, Server, Star, Network, Plus, X, Bookmark, Heart } from "lucide-react";
import { useUI } from "@/stores/ui";
import { useConnections, type Host, type ConnectionState } from "@/stores/connections";
import { useSavedHosts, removeSavedHost } from "@/stores/savedHosts";
import { useBookmarks, removeBookmark } from "@/stores/bookmarks";
import { useHostFavorites, removeHostFavorite } from "@/stores/hostFavorites";
import type { SavedHost, Bookmark as BookmarkType, HostFavorite, Location } from "@/types/bindings";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * 사이드바.
 *
 * - Local: home (MVP-0 placeholder)
 * - Hosts: `~/.ssh/config` 의 호스트 목록 + 연결 상태 점 + ad-hoc + 버튼.
 *   호스트 더블클릭 → ConnectionDialog. + 버튼 → AdHocConnectDialog.
 * - Saved hosts: 사용자가 ad-hoc dialog 에서 "Save host" 체크해서 저장한 호스트.
 *   더블클릭 → AdHocConnectDialog 가 저장값 prefill 로 열림.
 * - Bookmarks: 사용자가 북마크한 위치 (로컬/SSH). 더블클릭 → 해당 위치로 이동.
 * - Favorites: 활성 SSH 연결의 즐겨찾기 경로. alias 별 그룹화.
 */
export function Sidebar({
  onHostActivate,
  onAdHocOpen,
  onSavedActivate,
  onBookmarkActivate,
  onFavoriteActivate,
  onAddBookmark,
  onAddFavorite,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
  onSavedActivate: (host: SavedHost) => void;
  onBookmarkActivate: (location: Location) => void;
  onFavoriteActivate: (favorite: HostFavorite) => void;
  onAddBookmark: () => void;
  onAddFavorite: () => void;
}) {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 flex-col border-r border-border bg-subtle text-base">
      <Section title="Local" icon={<Folder size={14} />}>
        <Item label="Home" />
      </Section>
      <HostsSection onHostActivate={onHostActivate} onAdHocOpen={onAdHocOpen} />
      <SavedHostsSection onActivate={onSavedActivate} />
      <BookmarksSection onActivate={onBookmarkActivate} onAdd={onAddBookmark} />
      <HostFavoritesSection onActivate={onFavoriteActivate} onAdd={onAddFavorite} />
    </aside>
  );
}

function SavedHostsSection({
  onActivate,
}: {
  onActivate: (host: SavedHost) => void;
}) {
  const hosts = useSavedHosts((s) => s.hosts);
  return (
    <Section title="Saved hosts" icon={<Bookmark size={14} />}>
      {hosts.length === 0 ? (
        <Item label="(none — Save host on connect)" muted />
      ) : (
        hosts.map((h) => <SavedHostItem key={h.alias} host={h} onActivate={onActivate} />)
      )}
    </Section>
  );
}

function SavedHostItem({
  host,
  onActivate,
}: {
  host: SavedHost;
  onActivate: (host: SavedHost) => void;
}) {
  return (
    <div
      onDoubleClick={() => onActivate(host)}
      title={`${host.user}@${host.host}:${host.port}${host.key_path ? ` (key: ${host.key_path})` : ""}`}
      className="group flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
    >
      <Bookmark size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{host.alias}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void removeSavedHost(host.alias);
        }}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
        aria-label={`Remove saved host ${host.alias}`}
        title="Remove"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function BookmarksSection({
  onActivate,
  onAdd,
}: {
  onActivate: (location: Location) => void;
  onAdd: () => void;
}) {
  const items = useBookmarks((s) => s.items);
  return (
    <SectionWithAction
      title="Bookmarks"
      icon={<Star size={14} />}
      action={
        <button
          type="button"
          onClick={onAdd}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          aria-label="Add bookmark"
          title="Add active tab to bookmarks"
        >
          <Plus size={11} />
        </button>
      }
    >
      {items.length === 0 ? (
        <Item label="(none — + to add active tab)" muted />
      ) : (
        items.map((b) => (
          <BookmarkItem key={b.id} bookmark={b} onActivate={onActivate} />
        ))
      )}
    </SectionWithAction>
  );
}

function BookmarkItem({
  bookmark,
  onActivate,
}: {
  bookmark: BookmarkType;
  onActivate: (location: Location) => void;
}) {
  const sshPrefix = bookmark.location.source.kind === "ssh" ? "ssh:" : "";
  return (
    <div
      onDoubleClick={() => onActivate(bookmark.location)}
      title={`${sshPrefix}${bookmark.location.path}`}
      className="group flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
    >
      <Star size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{bookmark.name}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void removeBookmark(bookmark.id);
        }}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
        aria-label="Remove bookmark"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function HostFavoritesSection({
  onActivate,
  onAdd,
}: {
  onActivate: (favorite: HostFavorite) => void;
  onAdd: () => void;
}) {
  const items = useHostFavorites((s) => s.items);
  // 활성 connection 들을 Record 에서 배열로 변환
  const activeRecord = useConnections((s) => s.active);
  const actives = Object.values(activeRecord);
  const activeAliases = actives.map((c) => c.alias);
  const visible = items.filter((f) => activeAliases.includes(f.host_alias));
  // alias 별 그룹화
  const groups: Record<string, HostFavorite[]> = {};
  for (const f of visible) {
    (groups[f.host_alias] ??= []).push(f);
  }
  const groupKeys = Object.keys(groups).sort();

  return (
    <SectionWithAction
      title="Favorites"
      icon={<Heart size={14} />}
      action={
        <button
          type="button"
          onClick={onAdd}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          aria-label="Add favorite"
          title="Add active tab path (SSH only)"
        >
          <Plus size={11} />
        </button>
      }
    >
      {groupKeys.length === 0 ? (
        <Item label="(none — connect to host first)" muted />
      ) : (
        groupKeys.map((alias) => (
          <div key={alias}>
            <div className="px-2 text-meta text-fg-muted">{alias}</div>
            {groups[alias]!.map((f) => (
              <FavoriteItem key={f.id} fav={f} onActivate={onActivate} />
            ))}
          </div>
        ))
      )}
    </SectionWithAction>
  );
}

function FavoriteItem({
  fav,
  onActivate,
}: {
  fav: HostFavorite;
  onActivate: (favorite: HostFavorite) => void;
}) {
  return (
    <div
      onDoubleClick={() => onActivate(fav)}
      title={String(fav.path)}
      className="group flex cursor-default items-center gap-1 rounded py-0.5 pl-4 pr-2 hover:bg-border"
    >
      <Heart size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{fav.name}</span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void removeHostFavorite(fav.id);
        }}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger group-hover:opacity-100"
        aria-label="Remove favorite"
      >
        <X size={11} />
      </button>
    </div>
  );
}

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
    <SectionWithAction
      title="Hosts"
      icon={<Server size={14} />}
      action={
        <button
          type="button"
          onClick={onAdHocOpen}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          aria-label="Connect to host…"
          title="Connect to host…"
        >
          <Plus size={11} />
        </button>
      }
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
    </SectionWithAction>
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
  return (
    <div
      onDoubleClick={onActivate}
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

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center gap-1 text-meta text-fg-muted">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SectionWithAction({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: ReactNode;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center justify-between gap-1 text-meta text-fg-muted">
        <div className="flex items-center gap-1">
          {icon}
          <span>{title}</span>
        </div>
        {action}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Item({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div className={clsx("rounded px-2 py-0.5 hover:bg-border", muted && "text-fg-muted")}>
      {label}
    </div>
  );
}
