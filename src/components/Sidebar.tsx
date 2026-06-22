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
  Home,
  FileText,
  Download,
  Image as ImageIcon,
  Film,
  HardDrive,
  Clock,
  RefreshCw,
  ArrowUpFromLine,
  Monitor,
  Loader,
  ArrowRightLeft,
} from "lucide-react";
import { useEffect, Fragment, type ReactNode } from "react";
import { useUI } from "@/stores/ui";
import {
  useConnections,
  type Host,
  type ConnectionState,
} from "@/stores/connections";
import {
  useSavedHosts,
  removeSavedHost,
  reorderSavedHosts,
} from "@/stores/savedHosts";
import {
  useBookmarks,
  removeBookmark,
  reorderBookmarks,
} from "@/stores/bookmarks";
import {
  useHostFavorites,
  removeHostFavorite,
  reorderHostFavorites,
} from "@/stores/hostFavorites";
import {
  usePlaces,
  refreshVolumes,
  refreshRemoteVolumes,
  sourceKey,
} from "@/stores/places";
import { useRecents, type RecentEntry } from "@/stores/recents";
import {
  useHostGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  assignToGroup,
  moveGroup,
} from "@/stores/sidebarGroups";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { useToast } from "@/stores/toast";
import { useTasks, selectActive } from "@/stores/tasks";
import { useReorderable } from "@/hooks/useReorderable";
import { commands } from "@/types/bindings";
import { formatSize } from "@/lib/format";
import type {
  SavedHost,
  Bookmark as BookmarkType,
  HostFavorite,
  HostGroup,
  Location,
  Place,
  SourceId,
  TaskDto,
  Volume,
} from "@/types/bindings";
import clsx from "clsx";

/**
 * 사이드바.
 *
 * - 섹션 헤더 클릭으로 접기/펼치기(상태 영속), 접었을 때 항목 수 표시, 전체 세로 스크롤.
 * - 항목 우클릭 → 컨텍스트 메뉴(Open / Open in other pane / Copy path / Remove 등).
 * - Cmd/Ctrl+클릭 = 반대 패널에서 열기 (그냥 클릭은 활성 패널).
 * - Bookmarks / Saved hosts / Favorites(그룹 내) 는 드래그로 순서 변경.
 *
 * 섹션:
 * - Places: 표준 로컬 폴더(Home/Desktop/…) + Trash. (backend `places` 가 OS별 해석)
 * - Volumes: 마운트된 외장/네트워크 드라이브. (backend `volumes`)
 * - Hosts: `~/.ssh/config` 호스트 + 연결 상태 점 + ad-hoc. (읽기전용 — 재정렬 X)
 * - Saved hosts: ad-hoc dialog 에서 저장한 호스트. 더블클릭 → prefill 다이얼로그.
 * - Bookmarks: 북마크한 위치(로컬/SSH).
 * - Favorites: 호스트별 즐겨찾기 경로(재접속 안전). alias 별 그룹화 + 그룹 접기.
 * - Recent: 최근 방문 폴더(로컬/SSH). localStorage 영속.
 */
export function Sidebar({
  onHostActivate,
  onAdHocOpen,
  onSavedActivate,
  onOpenLocation,
  onOpenHostPath,
  onAddBookmark,
  onAddFavorite,
  onTrashActivate,
  onEject,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
  onSavedActivate: (host: SavedHost) => void;
  /** 로컬/SSH location 을 지정 패널로 이동. */
  onOpenLocation: (location: Location, pane: PaneId) => void;
  /** 호스트 경로로 이동(필요 시 자동 접속) — 지정 패널. */
  onOpenHostPath: (hostAlias: string, path: string, pane: PaneId) => void;
  onAddBookmark: () => void;
  onAddFavorite: () => void;
  /** 패널을 그 소스의 휴지통으로 이동 (삭제 항목 보기/복구). */
  onTrashActivate: (pane?: PaneId) => void;
  /** 볼륨 eject (확인 다이얼로그 오픈). */
  onEject: (volume: Volume) => void;
}) {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 min-h-0 flex-col overflow-y-auto border-r border-border bg-subtle text-base">
      <TasksSection />
      <LocalAnchor onOpenLocation={onOpenLocation} />
      <PlacesSection
        onOpenLocation={onOpenLocation}
        onTrashActivate={onTrashActivate}
      />
      <VolumesSection onOpenLocation={onOpenLocation} onEject={onEject} />
      <HostsSection onHostActivate={onHostActivate} onAdHocOpen={onAdHocOpen} />
      <SavedHostsSection onActivate={onSavedActivate} />
      <BookmarksSection onOpen={onOpenLocation} onAdd={onAddBookmark} />
      <HostFavoritesSection onOpen={onOpenHostPath} onAdd={onAddFavorite} />
      <RecentSection
        onOpenLocation={onOpenLocation}
        onOpenHostPath={onOpenHostPath}
      />
    </aside>
  );
}

// ─────────────────────────── pane targeting ───────────────────────────

/** Cmd/Ctrl 누르면 반대 패널, 아니면 활성 패널. */
function targetPane(e: { metaKey: boolean; ctrlKey: boolean }): PaneId {
  const active = usePanes.getState().activePane;
  if (e.metaKey || e.ctrlKey) return active === "left" ? "right" : "left";
  return active;
}

/** 활성 패널의 반대편. */
function otherPane(): PaneId {
  return usePanes.getState().activePane === "left" ? "right" : "left";
}

/** 로컬 path → Location. */
function localLocation(path: string): Location {
  return { source: { kind: "local" }, path };
}

/** 임의 source 의 path → Location (Places/Volumes 가 활성 패널 소스로 이동). */
function locationForSource(source: SourceId, path: string): Location {
  return { source, path };
}

/** 활성 패널(탭)의 source — Places/Volumes 가 이걸로 맞춰진다. */
function useActiveSource(): SourceId {
  return usePanes((s) => activeTab(s, s.activePane).location.source);
}

const EMPTY_PLACES: Place[] = [];
const EMPTY_VOLUMES: Volume[] = [];

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

const rowClass =
  "group flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border";

// ─────────────────────────── Tasks (background ops) ───────────────────────────

const TASK_VERB: Record<TaskDto["kind"], string> = {
  copy: "Copying",
  move: "Moving",
  extract: "Extracting",
  compress: "Compressing",
  sync: "Syncing",
  delete: "Deleting",
};

/**
 * 진행 중 백그라운드 작업(복사/이동/압축 등) 상태 — 활성 task 있을 때만 사이드바 최상단에
 * 표시. 각 행: 동사 + 현재 파일명 + 진행 바 + 바이트/속도 + 취소(X). 모달을 백그라운드로
 * 보내도 여기서 진행을 계속 본다. (데이터: useTasks — TasksBar 와 동일 소스.)
 */
function TasksSection() {
  const tasks = useTasks((s) => s.tasks);
  const active = selectActive(tasks);
  if (active.length === 0) return null;
  return (
    <div className="border-b border-border bg-base px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1 text-meta text-fg-muted">
        <ArrowRightLeft size={12} />
        <span>Tasks</span>
        <span className="ml-auto opacity-50">{active.length}</span>
      </div>
      <div className="space-y-1.5">
        {active.map((t) => (
          <SidebarTaskRow key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}

function SidebarTaskRow({ task }: { task: TaskDto }) {
  const p = task.progress;
  const indeterminate = !p || p.percent == null;
  const pct = p?.percent ?? 0;
  // 현재 파일명 우선, 없으면 task title.
  const label = p?.current_file || task.title;
  return (
    <div className="text-meta">
      <div className="flex items-center gap-1">
        <Loader size={11} className="shrink-0 animate-spin text-accent" />
        <span className="truncate text-fg" title={label}>
          {label}
        </span>
        <button
          type="button"
          onClick={() => commands.taskCancel(task.id)}
          className="ml-auto shrink-0 rounded p-0.5 text-fg-muted hover:bg-border hover:text-danger"
          aria-label="Cancel task"
          title="Cancel"
        >
          <X size={11} />
        </button>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-subtle">
        {indeterminate ? (
          <div className="h-full w-1/3 animate-indeterminate rounded bg-accent" />
        ) : (
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        )}
      </div>
      {p && (
        <div className="mt-0.5 flex justify-between text-fg-muted">
          <span>
            {TASK_VERB[task.kind]}
            {p.bytes_total
              ? ` ${formatSize(p.bytes_done)}/${formatSize(p.bytes_total)}`
              : ` ${formatSize(p.bytes_done)}`}
          </span>
          <span>{p.speed_bps ? `${formatSize(p.speed_bps)}/s` : ""}</span>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── Local anchor (This PC) ───────────────────────────

/**
 * 항상 보이는 "This PC (Local)" 앵커 — 활성 패널을 로컬(내 PC home)로 전환.
 * Places/Volumes 는 활성 패널 소스를 따라가므로 패널이 리모트면 로컬로 갈 길이 없었다.
 * 이게 그 탈출구. 패널이 이미 로컬이면 흐리게, 리모트면 강조(accent)해 눈에 띄게.
 * ⌘/Ctrl-클릭 = 반대 패널.
 */
function LocalAnchor({
  onOpenLocation,
}: {
  onOpenLocation: (location: Location, pane: PaneId) => void;
}) {
  const activeSource = useActiveSource();
  // 로컬 home 경로는 부트스트랩된 로컬 places 캐시에서(백엔드가 OS별 해석 — §7 준수).
  const localHome = usePlaces(
    (s) =>
      s.bySource["local"]?.places.find((p) => p.label === "Home")?.path ??
      s.bySource["local"]?.places[0]?.path,
  );
  if (!localHome) return null; // 로컬 places 부트스트랩 전(거의 즉시 채워짐)
  const isActiveLocal = activeSource.kind === "local";
  return (
    <button
      type="button"
      onClick={(e) => onOpenLocation(localLocation(localHome), targetPane(e))}
      title="Switch this pane to your local machine (⌘/Ctrl-click: other pane)"
      className={clsx(
        "flex w-full items-center gap-1 border-b border-border px-2 py-1 text-left hover:bg-border",
        isActiveLocal ? "text-fg-muted" : "font-medium text-accent",
      )}
    >
      <Monitor size={12} className="shrink-0" />
      <span className="truncate">This PC (Local)</span>
    </button>
  );
}

// ─────────────────────────── Places ───────────────────────────

function placeIcon(label: string): ReactNode {
  const cls = "shrink-0 text-fg-muted";
  switch (label) {
    case "Home":
      return <Home size={11} className={cls} />;
    case "Documents":
      return <FileText size={11} className={cls} />;
    case "Downloads":
      return <Download size={11} className={cls} />;
    case "Pictures":
      return <ImageIcon size={11} className={cls} />;
    case "Movies":
      return <Film size={11} className={cls} />;
    default:
      return <Folder size={11} className={cls} />;
  }
}

function PlacesSection({
  onOpenLocation,
  onTrashActivate,
}: {
  onOpenLocation: (location: Location, pane: PaneId) => void;
  onTrashActivate: (pane?: PaneId) => void;
}) {
  const source = useActiveSource();
  const places =
    usePlaces((s) => s.bySource[sourceKey(source)]?.places) ?? EMPTY_PLACES;
  return (
    <Section
      sectionKey="places"
      title="Places"
      icon={<Folder size={14} />}
      count={places.length}
    >
      {places.map((p) => (
        <PlaceItem
          key={p.label}
          place={p}
          source={source}
          onOpenLocation={onOpenLocation}
        />
      ))}
      <TrashItem onTrashActivate={onTrashActivate} />
    </Section>
  );
}

function PlaceItem({
  place,
  source,
  onOpenLocation,
}: {
  place: Place;
  source: SourceId;
  onOpenLocation: (location: Location, pane: PaneId) => void;
}) {
  const path = String(place.path);
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: "Open",
      onSelect: () =>
        onOpenLocation(
          locationForSource(source, path),
          usePanes.getState().activePane,
        ),
    },
    {
      id: "open-other",
      label: "Open in other pane",
      onSelect: () =>
        onOpenLocation(locationForSource(source, path), otherPane()),
    },
    { id: "copy-path", label: "Copy path", onSelect: () => copyText(path) },
  ];
  return (
    <button
      type="button"
      onClick={(e) =>
        onOpenLocation(locationForSource(source, path), targetPane(e))
      }
      onContextMenu={(e) => openMenu(e, menu)}
      title={path}
      className={clsx(rowClass, "w-full text-left")}
    >
      {placeIcon(place.label)}
      <span className="truncate">{place.label}</span>
    </button>
  );
}

function TrashItem({
  onTrashActivate,
}: {
  onTrashActivate: (pane?: PaneId) => void;
}) {
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: "Open",
      onSelect: () => onTrashActivate(usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: "Open in other pane",
      onSelect: () => onTrashActivate(otherPane()),
    },
  ];
  return (
    <button
      type="button"
      onClick={(e) => onTrashActivate(targetPane(e))}
      onContextMenu={(e) => openMenu(e, menu)}
      title="Browse trash (deleted items)"
      className={clsx(rowClass, "w-full text-left")}
    >
      <Trash2 size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">Trash</span>
    </button>
  );
}

// ─────────────────────────── Volumes ───────────────────────────

function VolumesSection({
  onOpenLocation,
  onEject,
}: {
  onOpenLocation: (location: Location, pane: PaneId) => void;
  onEject: (volume: Volume) => void;
}) {
  const source = useActiveSource();
  const volumes =
    usePlaces((s) => s.bySource[sourceKey(source)]?.volumes) ?? EMPTY_VOLUMES;
  const rescan = () => {
    if (source.kind === "local") void refreshVolumes();
    else void refreshRemoteVolumes(source.connection_id);
  };
  // 로컬은 사이드바가 열릴 때 재스캔. 원격은 연결 시 로드되며 포커스 전환 시 재조회 안 함
  // (수동 새로고침 버튼으로 갱신).
  useEffect(() => {
    void refreshVolumes();
  }, []);
  return (
    <Section
      sectionKey="volumes"
      title="Volumes"
      icon={<HardDrive size={14} />}
      count={volumes.length}
      action={
        <button
          type="button"
          onClick={rescan}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          title="Rescan volumes"
          aria-label="Rescan volumes"
        >
          <RefreshCw size={11} />
        </button>
      }
    >
      {volumes.length === 0 ? (
        <Item label="(no mounted volumes)" muted />
      ) : (
        volumes.map((v) => (
          <VolumeItem
            key={String(v.path)}
            volume={v}
            source={source}
            onOpenLocation={onOpenLocation}
            onEject={onEject}
          />
        ))
      )}
    </Section>
  );
}

function VolumeItem({
  volume,
  source,
  onOpenLocation,
  onEject,
}: {
  volume: Volume;
  source: SourceId;
  onOpenLocation: (location: Location, pane: PaneId) => void;
  onEject: (volume: Volume) => void;
}) {
  const path = String(volume.path);
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: "Open",
      onSelect: () =>
        onOpenLocation(
          locationForSource(source, path),
          usePanes.getState().activePane,
        ),
    },
    {
      id: "open-other",
      label: "Open in other pane",
      onSelect: () =>
        onOpenLocation(locationForSource(source, path), otherPane()),
    },
    { id: "copy-path", label: "Copy path", onSelect: () => copyText(path) },
    // eject 는 ejectable 볼륨만 (부트/시스템 볼륨·원격 마운트 제외 — backend 가 판정).
    ...(volume.ejectable
      ? ([
          { kind: "separator" },
          {
            id: "eject",
            label: "Eject",
            danger: true,
            onSelect: () => onEject(volume),
          },
        ] as MenuEntry[])
      : []),
  ];
  return (
    <div
      onClick={(e) =>
        onOpenLocation(locationForSource(source, path), targetPane(e))
      }
      onContextMenu={(e) => openMenu(e, menu)}
      title={path}
      className={rowClass}
    >
      <HardDrive size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{volume.name}</span>
      {volume.ejectable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEject(volume);
          }}
          className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-accent group-hover:opacity-100 focus:opacity-100"
          aria-label={`Eject ${volume.name}`}
          title="Eject"
        >
          <ArrowUpFromLine size={11} />
        </button>
      )}
    </div>
  );
}

// ─────────────────────────── Recent ───────────────────────────

function RecentSection({
  onOpenLocation,
  onOpenHostPath,
}: {
  onOpenLocation: (location: Location, pane: PaneId) => void;
  onOpenHostPath: (hostAlias: string, path: string, pane: PaneId) => void;
}) {
  const items = useRecents((s) => s.items);
  const clear = useRecents((s) => s.clear);
  return (
    <Section
      sectionKey="recent"
      title="Recent"
      icon={<Clock size={14} />}
      count={items.length}
      action={
        items.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
            title="Clear recents"
            aria-label="Clear recents"
          >
            <X size={11} />
          </button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <Item label="(no recent folders)" muted />
      ) : (
        items.map((r, i) => (
          <RecentItem
            key={`${r.source}:${r.source === "ssh" ? r.alias : ""}:${r.path}:${i}`}
            entry={r}
            onOpenLocation={onOpenLocation}
            onOpenHostPath={onOpenHostPath}
          />
        ))
      )}
    </Section>
  );
}

function RecentItem({
  entry,
  onOpenLocation,
  onOpenHostPath,
}: {
  entry: RecentEntry;
  onOpenLocation: (location: Location, pane: PaneId) => void;
  onOpenHostPath: (hostAlias: string, path: string, pane: PaneId) => void;
}) {
  const open = (pane: PaneId) => {
    if (entry.source === "ssh") onOpenHostPath(entry.alias, entry.path, pane);
    else onOpenLocation(localLocation(entry.path), pane);
  };
  const title =
    entry.source === "ssh" ? `${entry.alias}:${entry.path}` : entry.path;
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: "Open",
      onSelect: () => open(usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: "Open in other pane",
      onSelect: () => open(otherPane()),
    },
    {
      id: "copy-path",
      label: "Copy path",
      onSelect: () => copyText(entry.path),
    },
  ];
  return (
    <button
      type="button"
      onClick={(e) => open(targetPane(e))}
      onContextMenu={(e) => openMenu(e, menu)}
      title={title}
      className={clsx(rowClass, "w-full text-left")}
    >
      {entry.source === "ssh" ? (
        <Server size={11} className="shrink-0 text-fg-muted" />
      ) : (
        <Folder size={11} className="shrink-0 text-fg-muted" />
      )}
      <span className="truncate">{entry.label}</span>
      {entry.source === "ssh" && (
        <span className="ml-auto shrink-0 truncate text-meta opacity-50">
          {entry.alias}
        </span>
      )}
    </button>
  );
}

// ─────────────────────────── Saved hosts ───────────────────────────

function SavedHostsSection({
  onActivate,
}: {
  onActivate: (host: SavedHost) => void;
}) {
  const hosts = useSavedHosts((s) => s.hosts);
  const groups = useHostGroups((s) => s.groups);
  const byAlias = new Map(hosts.map((h) => [h.alias, h]));
  // 그룹에 배정된 alias 집합 (live 호스트만 — dangling 멤버 무시).
  const grouped = new Set<string>();
  for (const g of groups)
    for (const m of g.members) if (byAlias.has(m)) grouped.add(m);
  const ungrouped = hosts.filter((h) => !grouped.has(h.alias));
  // 재정렬 DnD 는 ungrouped 항목만 (그룹 내부는 메뉴로 관리).
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group: "saved",
    keys: ungrouped.map((h) => h.alias),
    onCommit: (next) => void reorderSavedHosts(next),
  });
  return (
    <Section
      sectionKey="saved"
      title="Saved hosts"
      icon={<Bookmark size={14} />}
      count={hosts.length}
    >
      {hosts.length === 0 ? (
        <Item label="(none — Save host on connect)" muted />
      ) : (
        <>
          {groups.map((g, gi) => (
            <HostGroupFolder
              key={g.id}
              group={g}
              members={g.members
                .map((a) => byAlias.get(a))
                .filter((h): h is SavedHost => !!h)}
              groups={groups}
              onActivate={onActivate}
              isFirst={gi === 0}
              isLast={gi === groups.length - 1}
            />
          ))}
          {ungrouped.map((h) => (
            <Fragment key={h.alias}>
              {dragKey && insertBeforeKey === h.alias && <DropLine />}
              <SavedHostItem
                host={h}
                currentGroupId={null}
                groups={groups}
                onActivate={onActivate}
                reorder={{
                  dragging: dragKey === h.alias,
                  onMouseDown: (e) => onItemMouseDown(e, h.alias),
                }}
              />
            </Fragment>
          ))}
          {dragKey && insertBeforeKey === null && <DropLine />}
        </>
      )}
    </Section>
  );
}

/** "Move to group ▸" 서브메뉴 — New / 다른 그룹 / Remove from group. */
function moveToGroupEntry(
  host: SavedHost,
  currentGroupId: string | null,
  groups: HostGroup[],
): MenuEntry {
  const children: MenuEntry[] = [
    {
      id: "new-group",
      label: "New group…",
      onSelect: () => {
        const name = window.prompt("New group name");
        if (name && name.trim()) void createGroup(name.trim(), host.alias);
      },
    },
  ];
  const others = groups.filter((g) => g.id !== currentGroupId);
  if (others.length > 0) {
    children.push({ kind: "separator" });
    for (const g of others) {
      children.push({
        id: `to-${g.id}`,
        label: g.name,
        onSelect: () => void assignToGroup(host.alias, g.id),
      });
    }
  }
  if (currentGroupId) {
    children.push({ kind: "separator" });
    children.push({
      id: "ungroup",
      label: "Remove from group",
      onSelect: () => void assignToGroup(host.alias, null),
    });
  }
  return { id: "move-group", label: "Move to group", children };
}

function HostGroupFolder({
  group,
  members,
  groups,
  onActivate,
  isFirst,
  isLast,
}: {
  group: HostGroup;
  members: SavedHost[];
  groups: HostGroup[];
  onActivate: (host: SavedHost) => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const collapsed = useUI((s) => s.collapsed[`hostgroup:${group.id}`]);
  const toggle = useUI((s) => s.toggleSection);
  const menu: MenuEntry[] = [
    {
      id: "rename",
      label: "Rename…",
      onSelect: () => {
        const n = window.prompt("Group name", group.name);
        if (n && n.trim()) void renameGroup(group.id, n.trim());
      },
    },
    {
      id: "up",
      label: "Move up",
      disabled: isFirst,
      onSelect: () => void moveGroup(group.id, -1),
    },
    {
      id: "down",
      label: "Move down",
      disabled: isLast,
      onSelect: () => void moveGroup(group.id, 1),
    },
    { kind: "separator" },
    {
      id: "delete",
      label: "Delete group",
      danger: true,
      onSelect: () => void deleteGroup(group.id),
    },
  ];
  return (
    <div>
      <button
        type="button"
        onClick={() => toggle(`hostgroup:${group.id}`)}
        onContextMenu={(e) => openMenu(e, menu)}
        className="flex w-full items-center gap-1 px-2 text-meta text-fg-muted hover:text-fg"
        title={group.name}
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        <Folder size={11} className="shrink-0" />
        <span className="truncate">{group.name}</span>
        <span className="ml-auto opacity-50">{members.length}</span>
      </button>
      {!collapsed &&
        members.map((h) => (
          <div key={h.alias} className="pl-2">
            <SavedHostItem
              host={h}
              currentGroupId={group.id}
              groups={groups}
              onActivate={onActivate}
            />
          </div>
        ))}
    </div>
  );
}

function SavedHostItem({
  host,
  currentGroupId,
  groups,
  onActivate,
  reorder,
}: {
  host: SavedHost;
  currentGroupId: string | null;
  groups: HostGroup[];
  onActivate: (host: SavedHost) => void;
  reorder?: { dragging: boolean; onMouseDown: (e: React.MouseEvent) => void };
}) {
  const menu: MenuEntry[] = [
    {
      id: "connect",
      label: "Connect / Edit…",
      onSelect: () => onActivate(host),
    },
    moveToGroupEntry(host, currentGroupId, groups),
    { kind: "separator" },
    {
      id: "remove",
      label: "Remove",
      danger: true,
      onSelect: () => void removeSavedHost(host.alias),
    },
  ];
  return (
    <div
      {...(reorder
        ? { "data-reorder-key": host.alias, "data-reorder-group": "saved" }
        : {})}
      onMouseDown={reorder?.onMouseDown}
      onDoubleClick={() => onActivate(host)}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${host.user}@${host.host}:${host.port}${host.key_path ? ` (key: ${host.key_path})` : ""}`}
      className={clsx(rowClass, reorder?.dragging && "opacity-50")}
    >
      <Bookmark size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{host.alias}</span>
      <DeleteBtn
        label={`Remove saved host ${host.alias}`}
        onClick={() => void removeSavedHost(host.alias)}
      />
    </div>
  );
}

// ─────────────────────────── Bookmarks ───────────────────────────

function BookmarksSection({
  onOpen,
  onAdd,
}: {
  onOpen: (location: Location, pane: PaneId) => void;
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
              onOpen={onOpen}
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
  onOpen,
  dragging,
  onMouseDown,
}: {
  bookmark: BookmarkType;
  onOpen: (location: Location, pane: PaneId) => void;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const sshPrefix = bookmark.location.source.kind === "ssh" ? "ssh:" : "";
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: "Open",
      onSelect: () => onOpen(bookmark.location, usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: "Open in other pane",
      onSelect: () => onOpen(bookmark.location, otherPane()),
    },
    {
      id: "copy-path",
      label: "Copy path",
      onSelect: () => copyText(String(bookmark.location.path)),
    },
    { kind: "separator" },
    {
      id: "remove",
      label: "Remove",
      danger: true,
      onSelect: () => void removeBookmark(bookmark.id),
    },
  ];
  return (
    <div
      data-reorder-key={bookmark.id}
      data-reorder-group="bookmarks"
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => onOpen(bookmark.location, targetPane(e))}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${sshPrefix}${bookmark.location.path}`}
      className={clsx(rowClass, dragging && "opacity-50")}
    >
      <Star size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{bookmark.name}</span>
      <DeleteBtn
        label="Remove bookmark"
        onClick={() => void removeBookmark(bookmark.id)}
      />
    </div>
  );
}

// ─────────────────────────── Host favorites ───────────────────────────

function HostFavoritesSection({
  onOpen,
  onAdd,
}: {
  onOpen: (hostAlias: string, path: string, pane: PaneId) => void;
  onAdd: () => void;
}) {
  const items = useHostFavorites((s) => s.items);
  const activeRecord = useConnections((s) => s.active);
  const activeAliases = new Set(
    Object.values(activeRecord).map((c) => c.alias),
  );
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
            onOpen={onOpen}
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
  onOpen,
}: {
  alias: string;
  favs: HostFavorite[];
  connected: boolean;
  onOpen: (hostAlias: string, path: string, pane: PaneId) => void;
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
        title={
          connected
            ? `${alias} (connected)`
            : `${alias} (click an item to connect)`
        }
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
              onOpen={onOpen}
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
  onOpen,
  dragging,
  onMouseDown,
}: {
  fav: HostFavorite;
  onOpen: (hostAlias: string, path: string, pane: PaneId) => void;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const path = String(fav.path);
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: "Open (connect if needed)",
      onSelect: () =>
        onOpen(fav.host_alias, path, usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: "Open in other pane",
      onSelect: () => onOpen(fav.host_alias, path, otherPane()),
    },
    { id: "copy-path", label: "Copy path", onSelect: () => copyText(path) },
    { kind: "separator" },
    {
      id: "remove",
      label: "Remove",
      danger: true,
      onSelect: () => void removeHostFavorite(fav.id),
    },
  ];
  return (
    <div
      data-reorder-key={fav.id}
      data-reorder-group={`fav:${fav.host_alias}`}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => onOpen(fav.host_alias, path, targetPane(e))}
      onContextMenu={(e) => openMenu(e, menu)}
      title={path}
      className={clsx(rowClass, "pl-4", dragging && "opacity-50")}
    >
      <Heart size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{fav.name}</span>
      <DeleteBtn
        label="Remove favorite"
        onClick={() => void removeHostFavorite(fav.id)}
      />
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
  const menu: MenuEntry[] = [
    { id: "connect", label: "Connect…", onSelect: onActivate },
  ];
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
        <Network
          size={11}
          className="ml-auto shrink-0 text-fg-muted"
          aria-label="ProxyJump"
        />
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
  return (
    <span
      aria-label={label}
      className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", cls)}
    />
  );
}

// ─────────────────────────── Shared building blocks ───────────────────────────

/** 접기 가능한 섹션 — 헤더 클릭으로 토글, 접었을 때 카운트, 선택적 action 버튼. */
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
    <div
      className={clsx(
        "rounded px-2 py-0.5 hover:bg-border",
        muted && "text-fg-muted",
      )}
    >
      {label}
    </div>
  );
}
