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
} from "lucide-react";
import { useEffect, Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
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
import { promptText } from "@/stores/promptDialog";
import { useReorderable } from "@/hooks/useReorderable";
import { ShelfSection } from "@/components/ShelfSection";
import { useHostNicknames, setHostNickname } from "@/stores/hostNicknames";
import { aliasLabel } from "@/lib/hostLabel";
import { TagBar } from "@/components/TagBar";
import {
  useTags,
  tagsFor,
  matchesTagFilter,
  editTagsPrompt,
  hostTagKey,
  bmTagKey,
  favTagKey,
} from "@/stores/tags";
import { useTagFilter } from "@/stores/tagFilter";
import type {
  SavedHost,
  Bookmark as BookmarkType,
  HostFavorite,
  HostGroup,
  Location,
  Place,
  SourceId,
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
  /** 패널을 그 소스의 휴지통으로 이동 (삭제 항목 보기/복구). */
  onTrashActivate: (pane?: PaneId) => void;
  /** 볼륨 eject (확인 다이얼로그 오픈). */
  onEject: (volume: Volume) => void;
}) {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 min-h-0 flex-col overflow-y-auto border-r border-border bg-subtle text-base">
      {/* 태스크 진행은 TasksBar(하단, 사이드바 접힘과 무관)로 일원화 — 중복 제거. */}
      <TagBar />
      <PlacesSection
        onOpenLocation={onOpenLocation}
        onTrashActivate={onTrashActivate}
        onEject={onEject}
      />
      <HostsSection
        onHostActivate={onHostActivate}
        onAdHocOpen={onAdHocOpen}
        onSavedActivate={onSavedActivate}
      />
      <BookmarksSection
        onOpen={onOpenLocation}
        onAdd={onAddBookmark}
        onOpenHostPath={onOpenHostPath}
      />
      <RecentSection
        onOpenLocation={onOpenLocation}
        onOpenHostPath={onOpenHostPath}
      />
      <ShelfSection />
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
    .then(() =>
      useToast
        .getState()
        .show(i18n.t("sidebar.copiedText", { text }), "success"),
    )
    .catch(() =>
      useToast.getState().show(i18n.t("toast.clipboardUnavailable"), "error"),
    );
}

/** 드래그 삽입 위치 표시 라인. */
function DropLine() {
  return <div className="mx-2 my-0.5 h-0.5 rounded bg-accent" />;
}

const rowClass =
  "group flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border";

// ─────────────────────────── Local anchor (This PC) ───────────────────────────

/**
 * 항상 보이는 "This PC (Local)" 앵커 — 활성 패널을 로컬(내 PC home)로 전환.
 * Places/Volumes 는 활성 패널 소스를 따라가므로 패널이 리모트면 로컬로 갈 길이 없었다.
 * 이게 그 탈출구. 패널이 이미 로컬이면 흐리게, 리모트면 강조(accent)해 눈에 띄게.
 * ⌘/Ctrl-클릭 = 반대 패널.
 */
// ─────────────────── Places (+ This PC 앵커 + Volumes) ───────────────────

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

/**
 * 통합 Places 섹션 — 활성 패널 소스의 표준폴더 + Trash + Volumes(SubLabel) 한 묶음.
 * 활성 패널이 원격일 때만 상단에 "This PC" 앵커(로컬로 전환). 11→정리의 핵심.
 */
function PlacesSection({
  onOpenLocation,
  onTrashActivate,
  onEject,
}: {
  onOpenLocation: (location: Location, pane: PaneId) => void;
  onTrashActivate: (pane?: PaneId) => void;
  onEject: (volume: Volume) => void;
}) {
  const { t } = useTranslation();
  const source = useActiveSource();
  const places =
    usePlaces((s) => s.bySource[sourceKey(source)]?.places) ?? EMPTY_PLACES;
  const volumes =
    usePlaces((s) => s.bySource[sourceKey(source)]?.volumes) ?? EMPTY_VOLUMES;
  // 로컬 home — This PC 앵커용(백엔드가 OS별 해석 — §7 준수).
  const localHome = usePlaces(
    (s) =>
      s.bySource["local"]?.places.find((p) => p.label === "Home")?.path ??
      s.bySource["local"]?.places[0]?.path,
  );
  const rescan = () => {
    if (source.kind === "local") void refreshVolumes();
    else void refreshRemoteVolumes(source.connection_id);
  };
  // 로컬 볼륨은 사이드바 마운트 시 1회 재스캔.
  useEffect(() => {
    void refreshVolumes();
  }, []);
  return (
    <Section
      sectionKey="places"
      title={t("sidebar.places")}
      icon={<Folder size={14} />}
      count={places.length + volumes.length}
      action={
        <button
          type="button"
          onClick={rescan}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          title={t("sidebar.rescanVolumes")}
          aria-label={t("sidebar.rescanVolumes")}
        >
          <RefreshCw size={11} />
        </button>
      }
    >
      {localHome && source.kind !== "local" && (
        <button
          type="button"
          onClick={(e) =>
            onOpenLocation(localLocation(localHome), targetPane(e))
          }
          title={t("sidebar.thisPcTitle")}
          className={clsx(rowClass, "w-full text-left font-medium text-accent")}
        >
          <Monitor size={11} className="shrink-0" />
          <span className="truncate">{t("sidebar.thisPc")}</span>
        </button>
      )}
      {places.map((p) => (
        <PlaceItem
          key={p.label}
          place={p}
          source={source}
          onOpenLocation={onOpenLocation}
        />
      ))}
      <TrashItem onTrashActivate={onTrashActivate} />
      {volumes.length > 0 && <SubLabel>{t("sidebar.volumes")}</SubLabel>}
      {volumes.map((v) => (
        <VolumeItem
          key={String(v.path)}
          volume={v}
          source={source}
          onOpenLocation={onOpenLocation}
          onEject={onEject}
        />
      ))}
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
  const { t } = useTranslation();
  const path = String(place.path);
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: t("menu.open"),
      onSelect: () =>
        onOpenLocation(
          locationForSource(source, path),
          usePanes.getState().activePane,
        ),
    },
    {
      id: "open-other",
      label: t("menu.openInOtherPane"),
      onSelect: () =>
        onOpenLocation(locationForSource(source, path), otherPane()),
    },
    {
      id: "copy-path",
      label: t("menu.copyPath"),
      onSelect: () => copyText(path),
    },
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
  const { t } = useTranslation();
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: t("menu.open"),
      onSelect: () => onTrashActivate(usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: t("menu.openInOtherPane"),
      onSelect: () => onTrashActivate(otherPane()),
    },
  ];
  return (
    <button
      type="button"
      onClick={(e) => onTrashActivate(targetPane(e))}
      onContextMenu={(e) => openMenu(e, menu)}
      title={t("sidebar.trashTitle")}
      className={clsx(rowClass, "w-full text-left")}
    >
      <Trash2 size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{t("sidebar.trash")}</span>
    </button>
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
  const { t } = useTranslation();
  const path = String(volume.path);
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: t("menu.open"),
      onSelect: () =>
        onOpenLocation(
          locationForSource(source, path),
          usePanes.getState().activePane,
        ),
    },
    {
      id: "open-other",
      label: t("menu.openInOtherPane"),
      onSelect: () =>
        onOpenLocation(locationForSource(source, path), otherPane()),
    },
    {
      id: "copy-path",
      label: t("menu.copyPath"),
      onSelect: () => copyText(path),
    },
    // eject 는 ejectable 볼륨만 (부트/시스템 볼륨·원격 마운트 제외 — backend 가 판정).
    ...(volume.ejectable
      ? ([
          { kind: "separator" },
          {
            id: "eject",
            label: t("sidebar.eject"),
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
          aria-label={t("sidebar.ejectName", { name: volume.name })}
          title={t("sidebar.eject")}
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
  const { t } = useTranslation();
  const items = useRecents((s) => s.items);
  const clear = useRecents((s) => s.clear);
  return (
    <Section
      sectionKey="recent"
      title={t("sidebar.recent")}
      icon={<Clock size={14} />}
      count={items.length}
      action={
        items.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
            title={t("sidebar.clearRecents")}
            aria-label={t("sidebar.clearRecents")}
          >
            <X size={11} />
          </button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <Item label={t("sidebar.noRecent")} muted />
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
  const { t } = useTranslation();
  const open = (pane: PaneId) => {
    if (entry.source === "ssh") onOpenHostPath(entry.alias, entry.path, pane);
    else onOpenLocation(localLocation(entry.path), pane);
  };
  const title =
    entry.source === "ssh" ? `${entry.alias}:${entry.path}` : entry.path;
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: t("menu.open"),
      onSelect: () => open(usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: t("menu.openInOtherPane"),
      onSelect: () => open(otherPane()),
    },
    {
      id: "copy-path",
      label: t("menu.copyPath"),
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

/**
 * 저장 호스트 본문(Section 래퍼 없음) — 통합 Hosts 섹션 안에서 config 호스트 아래에
 * 렌더된다. `hideAliases` 로 config 와 중복되는 alias 는 숨겨(같은 머신 2중 표시 방지).
 */
function SavedHostsBody({
  onActivate,
  hideAliases,
}: {
  onActivate: (host: SavedHost) => void;
  hideAliases: Set<string>;
}) {
  const { t } = useTranslation();
  const rawHosts = useSavedHosts((s) => s.hosts);
  const byKey = useTags((s) => s.byKey);
  const active = useTagFilter((s) => s.active);
  const allHosts = rawHosts.filter((h) =>
    matchesTagFilter(tagsFor(byKey, hostTagKey(h.alias)), active),
  );
  const hosts = allHosts.filter((h) => !hideAliases.has(h.alias));
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
  if (allHosts.length === 0) return null;
  return (
    <>
      <SubLabel>{t("sidebar.saved")}</SubLabel>
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
  );
}

/** 통합 Hosts 섹션 내부의 작은 구분 라벨(~/.ssh/config / Saved). */
function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-0.5 pt-1 text-meta uppercase tracking-wide text-fg-muted/50">
      {children}
    </div>
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
      label: i18n.t("sidebar.newGroup"),
      onSelect: () => {
        void promptText({ title: i18n.t("sidebar.newGroupPrompt") }).then(
          (name) => {
            if (name && name.trim()) void createGroup(name.trim(), host.alias);
          },
        );
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
      label: i18n.t("sidebar.removeFromGroup"),
      onSelect: () => void assignToGroup(host.alias, null),
    });
  }
  return { id: "move-group", label: i18n.t("sidebar.moveToGroup"), children };
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
  const { t } = useTranslation();
  const collapsed = useUI((s) => s.collapsed[`hostgroup:${group.id}`]);
  const toggle = useUI((s) => s.toggleSection);
  const menu: MenuEntry[] = [
    {
      id: "rename",
      label: t("sidebar.renameGroup"),
      onSelect: () => {
        void promptText({
          title: t("sidebar.groupNamePrompt"),
          initial: group.name,
        }).then((n) => {
          if (n && n.trim()) void renameGroup(group.id, n.trim());
        });
      },
    },
    {
      id: "up",
      label: t("sidebar.moveUp"),
      disabled: isFirst,
      onSelect: () => void moveGroup(group.id, -1),
    },
    {
      id: "down",
      label: t("sidebar.moveDown"),
      disabled: isLast,
      onSelect: () => void moveGroup(group.id, 1),
    },
    { kind: "separator" },
    {
      id: "delete",
      label: t("sidebar.deleteGroup"),
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
  const { t } = useTranslation();
  const nickname = useHostNicknames((s) => s.byAlias)[host.alias];
  const tags = tagsFor(
    useTags((s) => s.byKey),
    hostTagKey(host.alias),
  );
  const display = nickname ?? host.alias;
  const menu: MenuEntry[] = [
    {
      id: "connect",
      label: t("sidebar.connectEdit"),
      onSelect: () => onActivate(host),
    },
    {
      id: "rename",
      label: t("sidebar.setDisplayName"),
      onSelect: () => {
        void promptText({
          title: t("sidebar.displayNamePrompt", { alias: host.alias }),
          initial: nickname ?? "",
        }).then((next) => {
          if (next !== null) void setHostNickname(host.alias, next);
        });
      },
    },
    {
      id: "tags",
      label: t("sidebar.editTags"),
      onSelect: () => editTagsPrompt(hostTagKey(host.alias), tags),
    },
    moveToGroupEntry(host, currentGroupId, groups),
    { kind: "separator" },
    {
      id: "remove",
      label: t("sidebar.remove"),
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
      title={`${host.user}@${host.host}:${host.port}${host.key_path ? ` (key: ${host.key_path})` : ""}${nickname ? ` · ${host.alias}` : ""}`}
      className={clsx(rowClass, reorder?.dragging && "opacity-50")}
    >
      <Bookmark size={11} className="shrink-0 text-fg-muted" />
      <span className="truncate">{display}</span>
      {nickname && (
        <span className="shrink-0 truncate text-meta text-fg-muted/60">
          {host.alias}
        </span>
      )}
      <InlineTags tags={tags} />
      <DeleteBtn
        label={t("sidebar.removeSavedHost", { alias: host.alias })}
        onClick={() => void removeSavedHost(host.alias)}
      />
    </div>
  );
}

// ─────────────────────────── Bookmarks ───────────────────────────

/**
 * 통합 Bookmarks 섹션 — 로컬 북마크 + 원격 즐겨찾기(호스트별)를 한 목록으로.
 * "+" 는 활성 탭을 북마크(bookmarkLocation 이 로컬→북마크 / SSH→호스트 즐겨찾기로 라우팅).
 */
function BookmarksSection({
  onOpen,
  onAdd,
  onOpenHostPath,
}: {
  onOpen: (location: Location, pane: PaneId) => void;
  onAdd: () => void;
  onOpenHostPath: (hostAlias: string, path: string, pane: PaneId) => void;
}) {
  const { t } = useTranslation();
  const allItems = useBookmarks((s) => s.items);
  const allFav = useHostFavorites((s) => s.items);
  const byKey = useTags((s) => s.byKey);
  const tagFilter = useTagFilter((s) => s.active);
  const activeAliases = new Set(
    Object.values(useConnections((s) => s.active)).map((c) => c.alias),
  );
  // 태그 필터 — 로컬 북마크는 bm:<id>, 원격 즐겨찾기는 fav:<id> 키.
  const items = allItems.filter((b) =>
    matchesTagFilter(tagsFor(byKey, bmTagKey(b.id)), tagFilter),
  );
  const favItems = allFav.filter((f) =>
    matchesTagFilter(tagsFor(byKey, favTagKey(f.id)), tagFilter),
  );
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group: "bookmarks",
    keys: items.map((b) => b.id),
    onCommit: (next) => void reorderBookmarks(next),
  });
  const favGroups: Record<string, HostFavorite[]> = {};
  for (const f of favItems) (favGroups[f.host_alias] ??= []).push(f);
  const favKeys = Object.keys(favGroups).sort();
  // 전체 개수(배지·빈상태 판단)는 필터 무관, 표시는 필터 적용분.
  const totalAll = allItems.length + allFav.length;
  const total = items.length + favItems.length;

  return (
    <Section
      sectionKey="bookmarks"
      title={t("sidebar.bookmarks")}
      icon={<Star size={14} />}
      count={totalAll}
      action={<AddBtn label={t("sidebar.bookmarkActiveTab")} onClick={onAdd} />}
    >
      {totalAll === 0 ? (
        <Item label={t("sidebar.noBookmarks")} muted />
      ) : total === 0 ? (
        <Item label={t("sidebar.noTagMatch")} muted />
      ) : (
        <>
          {items.length > 0 && <SubLabel>{t("sidebar.local")}</SubLabel>}
          {items.map((b) => (
            <Fragment key={b.id}>
              {dragKey && insertBeforeKey === b.id && <DropLine />}
              <BookmarkItem
                bookmark={b}
                onOpen={onOpen}
                dragging={dragKey === b.id}
                onMouseDown={(e) => onItemMouseDown(e, b.id)}
              />
            </Fragment>
          ))}
          {dragKey && insertBeforeKey === null && <DropLine />}
          {favKeys.length > 0 && <SubLabel>{t("sidebar.remote")}</SubLabel>}
          {favKeys.map((alias) => (
            <FavoriteGroup
              key={alias}
              alias={alias}
              favs={favGroups[alias]!}
              connected={activeAliases.has(alias)}
              onOpen={onOpenHostPath}
            />
          ))}
        </>
      )}
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
  const { t } = useTranslation();
  const sshPrefix = bookmark.location.source.kind === "ssh" ? "ssh:" : "";
  const tags = tagsFor(
    useTags((s) => s.byKey),
    bmTagKey(bookmark.id),
  );
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: t("menu.open"),
      onSelect: () => onOpen(bookmark.location, usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: t("menu.openInOtherPane"),
      onSelect: () => onOpen(bookmark.location, otherPane()),
    },
    {
      id: "copy-path",
      label: t("menu.copyPath"),
      onSelect: () => copyText(String(bookmark.location.path)),
    },
    {
      id: "tags",
      label: t("sidebar.editTags"),
      onSelect: () => editTagsPrompt(bmTagKey(bookmark.id), tags),
    },
    { kind: "separator" },
    {
      id: "remove",
      label: t("sidebar.remove"),
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
      <InlineTags tags={tags} />
      <DeleteBtn
        label={t("sidebar.removeBookmark")}
        onClick={() => void removeBookmark(bookmark.id)}
      />
    </div>
  );
}

// ─────────────────────── Host favorites (Bookmarks 내 원격 그룹) ───────────────────────

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
  const { t } = useTranslation();
  const collapsed = useUI((s) => s.collapsed[`fav:${alias}`]);
  const toggle = useUI((s) => s.toggleSection);
  const nicks = useHostNicknames((s) => s.byAlias);
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
            ? t("sidebar.hostConnectedTitle", { alias })
            : t("sidebar.hostClickConnectTitle", { alias })
        }
      >
        {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
        <span
          className={clsx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            connected ? "bg-success" : "bg-fg-muted/30",
          )}
        />
        <span className="truncate">{aliasLabel(alias, nicks)}</span>
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
  const { t } = useTranslation();
  const path = String(fav.path);
  const tags = tagsFor(
    useTags((s) => s.byKey),
    favTagKey(fav.id),
  );
  const menu: MenuEntry[] = [
    {
      id: "open",
      label: t("sidebar.openConnect"),
      onSelect: () =>
        onOpen(fav.host_alias, path, usePanes.getState().activePane),
    },
    {
      id: "open-other",
      label: t("menu.openInOtherPane"),
      onSelect: () => onOpen(fav.host_alias, path, otherPane()),
    },
    {
      id: "copy-path",
      label: t("menu.copyPath"),
      onSelect: () => copyText(path),
    },
    {
      id: "tags",
      label: t("sidebar.editTags"),
      onSelect: () => editTagsPrompt(favTagKey(fav.id), tags),
    },
    { kind: "separator" },
    {
      id: "remove",
      label: t("sidebar.remove"),
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
      <InlineTags tags={tags} />
      <DeleteBtn
        label={t("sidebar.removeFavorite")}
        onClick={() => void removeHostFavorite(fav.id)}
      />
    </div>
  );
}

// ─────────────────────────── Hosts (read-only) ───────────────────────────

/**
 * 통합 Hosts 섹션 — ~/.ssh/config 호스트 + 저장(ad-hoc) 호스트를 한 목록으로.
 * 같은 alias 가 양쪽에 있으면 config 가 우선(저장본은 숨김) → 같은 머신 2중 표시 방지.
 */
function HostsSection({
  onHostActivate,
  onAdHocOpen,
  onSavedActivate,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
  onSavedActivate: (host: SavedHost) => void;
}) {
  const { t } = useTranslation();
  const allHosts = useConnections((s) => s.hosts);
  const stateByAlias = useConnections((s) => s.stateByAlias)();
  const savedCount = useSavedHosts((s) => s.hosts.length);
  const byKey = useTags((s) => s.byKey);
  const active = useTagFilter((s) => s.active);
  const configAliases = new Set(allHosts.map((h) => h.alias));
  // 태그 필터 — config 호스트는 host:<alias> 키.
  const hosts = allHosts.filter((h) =>
    matchesTagFilter(tagsFor(byKey, hostTagKey(h.alias)), active),
  );

  return (
    <Section
      sectionKey="hosts"
      title={t("sidebar.hosts")}
      icon={<Server size={14} />}
      count={allHosts.length + savedCount}
      action={<AddBtn label={t("dialog.adhoc.title")} onClick={onAdHocOpen} />}
    >
      {allHosts.length === 0 && savedCount === 0 ? (
        <Item label={t("sidebar.noHosts")} muted />
      ) : (
        <>
          {hosts.length > 0 && <SubLabel>~/.ssh/config</SubLabel>}
          {hosts.map((h) => (
            <HostItem
              key={h.alias}
              host={h}
              state={stateByAlias[h.alias] ?? { kind: "disconnected" }}
              onActivate={() => onHostActivate(h.alias)}
            />
          ))}
          <SavedHostsBody
            onActivate={onSavedActivate}
            hideAliases={configAliases}
          />
        </>
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
  const { t } = useTranslation();
  const nicks = useHostNicknames((s) => s.byAlias);
  const byKey = useTags((s) => s.byKey);
  const tags = tagsFor(byKey, hostTagKey(host.alias));
  const nickname = nicks[host.alias];
  const display = nickname ?? host.alias;

  // 별명 설정/해제 — config alias 키로 저장. 패널·상태바도 이 별명을 따른다.
  const promptName = () => {
    void promptText({
      title: t("sidebar.displayNamePrompt", { alias: host.alias }),
      initial: nickname ?? "",
    }).then((next) => {
      if (next !== null) void setHostNickname(host.alias, next);
    });
  };

  const menu: MenuEntry[] = [
    { id: "connect", label: t("sidebar.connect"), onSelect: onActivate },
    { id: "rename", label: t("sidebar.setDisplayName"), onSelect: promptName },
    {
      id: "tags",
      label: t("sidebar.editTags"),
      onSelect: () => editTagsPrompt(hostTagKey(host.alias), tags),
    },
  ];
  if (nickname) {
    menu.push({
      id: "reset-name",
      label: t("sidebar.resetDisplayName"),
      onSelect: () => void setHostNickname(host.alias, ""),
    });
  }
  return (
    <div
      onDoubleClick={onActivate}
      onContextMenu={(e) => openMenu(e, menu)}
      title={`${host.user}@${host.hostname}:${host.port}${host.has_proxy_jump ? " (via jump)" : ""}${nickname ? ` · ${host.alias}` : ""}`}
      className="flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
    >
      <StateDot state={state} />
      <span className="truncate">{display}</span>
      {nickname && (
        <span className="shrink-0 truncate text-meta text-fg-muted/60">
          {host.alias}
        </span>
      )}
      <InlineTags tags={tags} />
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
  const { t } = useTranslation();
  const cls = {
    connected: "bg-success",
    connecting: "bg-warning animate-pulse",
    error: "bg-danger",
    disconnected: "bg-fg-muted/30",
  }[state.kind];
  const label =
    state.kind === "error" ? state.message : t(`sidebar.state.${state.kind}`);
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
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="ml-auto shrink-0 rounded p-0.5 text-fg-muted opacity-0 hover:bg-border hover:text-danger focus:opacity-100 group-hover:opacity-100"
      aria-label={label}
      title={t("sidebar.remove")}
    >
      <X size={11} />
    </button>
  );
}

/** 행에 붙는 태그 표시(작은 회색 #tag). 없으면 렌더 안 함. */
function InlineTags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <span
      className="shrink-0 truncate text-meta text-fg-muted/60"
      title={tags.map((t) => `#${t}`).join(" ")}
    >
      {tags.map((t) => `#${t}`).join(" ")}
    </span>
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
