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
  TriangleAlert,
  Home,
  FileText,
  Download,
  Image as ImageIcon,
  Film,
  HardDrive,
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
import { useSidebarFilter, matchesQuery } from "@/stores/sidebarFilter";
import { SidebarFilter, RowLabel } from "@/components/SidebarFilter";
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
    <aside className="flex w-48 min-h-0 flex-col overflow-y-auto border-r border-border bg-subtle pb-2 text-base">
      {/* 태스크 진행은 TasksBar(하단, 사이드바 접힘과 무관)로 일원화 — 중복 제거. */}
      <SidebarFilter />
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

/**
 * 사이드바 행 — 26px, 아이콘 14px, gap 8px. 좌측 2px 바는 늘 자리를 잡아두고(투명)
 * 활성일 때만 accent 로 칠한다 — EntryRow 와 같은 어휘라 폭이 흔들리지 않는다.
 * 예전엔 23.5px 라 DESIGN.md 가 정한 최소 클릭 타겟 24px 에 못 미쳤다.
 */
const rowClass =
  "group flex h-[26px] cursor-default items-center gap-2 rounded border-l-2 border-l-transparent pl-1.5 pr-1.5 hover:bg-border";

/** 활성 행 — 이 위치를 패널이 보고 있다. */
const rowActiveClass = "border-l-accent bg-active hover:bg-active";

/**
 * 이 위치를 보고 있는 패널 배지 문자열("L"/"R"/"LR", 없으면 ""). 사이드바에서 연
 * 결과가 화면에 남지 않던 문제. **원시값**을 반환해야 셀렉터가 매 렌더 새 참조를
 * 만들지 않는다(무한 리렌더 방지).
 */
function usePaneAt(source: SourceId, path: string): string {
  const key = sourceKey(source);
  return usePanes((s) => {
    let out = "";
    for (const id of ["left", "right"] as const) {
      const loc = activeTab(s, id).location;
      if (String(loc.path) === path && sourceKey(loc.source) === key)
        out += id === "left" ? "L" : "R";
    }
    return out;
  });
}

/** 어느 패널이 이 위치를 보고 있는지 — 행 오른쪽 끝 작은 배지. */
function PaneBadge({ pane }: { pane: string }) {
  if (!pane) return null;
  return (
    <span className="ml-auto shrink-0 rounded-[3px] bg-accent/15 px-1 py-0.5 text-[10px] font-medium leading-none text-accent">
      {pane}
    </span>
  );
}

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
      return <Home size={14} className={cls} />;
    case "Documents":
      return <FileText size={14} className={cls} />;
    case "Downloads":
      return <Download size={14} className={cls} />;
    case "Pictures":
      return <ImageIcon size={14} className={cls} />;
    case "Movies":
      return <Film size={14} className={cls} />;
    default:
      return <Folder size={14} className={cls} />;
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
  const q = useSidebarFilter((s) => s.q);
  const filtering = q.trim() !== "";
  const allPlaces =
    usePlaces((s) => s.bySource[sourceKey(source)]?.places) ?? EMPTY_PLACES;
  const allVolumes =
    usePlaces((s) => s.bySource[sourceKey(source)]?.volumes) ?? EMPTY_VOLUMES;
  const places = allPlaces.filter((p) => matchesQuery(p.label, q));
  const volumes = allVolumes.filter((v) => matchesQuery(v.name, q));
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
  const trashMatch = matchesQuery(t("sidebar.trash"), q);
  if (filtering && places.length + volumes.length === 0 && !trashMatch)
    return null;
  return (
    <Section
      first
      sectionKey="places"
      title={t("sidebar.places")}
      count={allPlaces.length + allVolumes.length}
      action={
        <button
          type="button"
          onClick={rescan}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          title={t("sidebar.rescanVolumes")}
          aria-label={t("sidebar.rescanVolumes")}
        >
          <RefreshCw size={12} />
        </button>
      }
    >
      {localHome && source.kind !== "local" && !filtering && (
        <button
          type="button"
          onClick={(e) =>
            onOpenLocation(localLocation(localHome), targetPane(e))
          }
          title={t("sidebar.thisPcTitle")}
          className={clsx(rowClass, "w-full text-left font-medium text-accent")}
        >
          <Monitor size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("sidebar.thisPc")}</span>
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
      {trashMatch && <TrashItem onTrashActivate={onTrashActivate} />}
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
  const pane = usePaneAt(source, path);
  return (
    <button
      type="button"
      onClick={(e) =>
        onOpenLocation(locationForSource(source, path), targetPane(e))
      }
      onContextMenu={(e) => openMenu(e, menu)}
      title={path}
      className={clsx(rowClass, "w-full text-left", pane && rowActiveClass)}
    >
      {placeIcon(place.label)}
      <RowLabel text={place.label} />
      <PaneBadge pane={pane} />
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
      <Trash2 size={14} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1 truncate">{t("sidebar.trash")}</span>
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
  const pane = usePaneAt(source, path);
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
      className={clsx(rowClass, pane && rowActiveClass)}
    >
      <HardDrive size={14} className="shrink-0 text-fg-muted" />
      <RowLabel text={volume.name} />
      <PaneBadge pane={pane} />
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
          <ArrowUpFromLine size={12} />
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
  const allItems = useRecents((s) => s.items);
  const clear = useRecents((s) => s.clear);
  const q = useSidebarFilter((s) => s.q);
  const items = allItems.filter((r) => matchesQuery(r.label, q));
  if (q.trim() !== "" && items.length === 0) return null;
  return (
    <Section
      sectionKey="recent"
      title={t("sidebar.recent")}
      count={allItems.length}
      action={
        allItems.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
            title={t("sidebar.clearRecents")}
            aria-label={t("sidebar.clearRecents")}
          >
            <X size={12} />
          </button>
        ) : undefined
      }
    >
      {allItems.length === 0 ? (
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
        <Server size={14} className="shrink-0 text-fg-muted" />
      ) : (
        <Folder size={14} className="shrink-0 text-fg-muted" />
      )}
      <RowLabel text={entry.label} />
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
  const nicks = useHostNicknames((s) => s.byAlias);
  const q = useSidebarFilter((s) => s.q);
  const hosts = allHosts.filter(
    (h) =>
      !hideAliases.has(h.alias) && matchesQuery(nicks[h.alias] ?? h.alias, q),
  );
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
    <div className="flex h-[18px] items-center pl-3.5 pr-2 text-meta text-fg-muted">
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
      <Bookmark size={14} className="shrink-0 text-fg-muted" />
      <RowLabel text={display} />
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
  const q = useSidebarFilter((s) => s.q);
  const tagFilter = useTagFilter((s) => s.active);
  // 살아있는(connected) 연결만 — 재연결 포기로 죽은 entry 도 배너용으로 store 에
  // 남아 있어서, 그대로 세면 끊긴 호스트가 "연결됨" 초록 점으로 보인다.
  const activeAliases = new Set(
    Object.values(useConnections((s) => s.active))
      .filter((c) => c.state.kind === "connected")
      .map((c) => c.alias),
  );
  // 태그 필터 — 로컬 북마크는 bm:<id>, 원격 즐겨찾기는 fav:<id> 키.
  // 이름 필터(q)는 그 위에 한 번 더 좁힌다.
  const items = allItems.filter(
    (b) =>
      matchesTagFilter(tagsFor(byKey, bmTagKey(b.id)), tagFilter) &&
      matchesQuery(b.name, q),
  );
  const favItems = allFav.filter(
    (f) =>
      matchesTagFilter(tagsFor(byKey, favTagKey(f.id)), tagFilter) &&
      matchesQuery(f.name, q),
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
  if (q.trim() !== "" && total === 0) return null;

  return (
    <Section
      sectionKey="bookmarks"
      title={t("sidebar.bookmarks")}
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
      <Star size={14} className="shrink-0 text-fg-muted" />
      <RowLabel text={bookmark.name} />
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
      <Heart size={14} className="shrink-0 text-fg-muted" />
      <RowLabel text={fav.name} />
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
  const nicks = useHostNicknames((s) => s.byAlias);
  const q = useSidebarFilter((s) => s.q);
  // 태그 필터 — config 호스트는 host:<alias> 키. 이름 필터는 별명 우선(화면에 보이는 것).
  const hosts = allHosts.filter(
    (h) =>
      matchesTagFilter(tagsFor(byKey, hostTagKey(h.alias)), active) &&
      matchesQuery(nicks[h.alias] ?? h.alias, q),
  );

  return (
    <Section
      sectionKey="hosts"
      title={t("sidebar.hosts")}
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
      className={rowClass}
    >
      <StateDot state={state} />
      <RowLabel text={display} />
      {nickname && (
        <span className="shrink-0 truncate text-meta text-fg-muted/60">
          {host.alias}
        </span>
      )}
      <InlineTags tags={tags} />
      {host.has_proxy_jump && (
        <Network
          size={14}
          className="ml-auto shrink-0 text-fg-muted"
          aria-label="ProxyJump"
        />
      )}
    </div>
  );
}

/**
 * 연결 상태 표식 — **모양**이 먼저다. 넷 다 같은 점에 색만 다르면 색을 못 보는 사람은
 * 물론 라이트 모드의 옅은 회색 점도 구분이 안 된다. 채운 원 / 반쯤 찬 원 / 빈 원 /
 * 삼각형으로 가른다 (비교창의 상태 아이콘과 같은 원칙).
 */
function StateDot({ state }: { state: ConnectionState }) {
  const { t } = useTranslation();
  const label =
    state.kind === "error" ? state.message : t(`sidebar.state.${state.kind}`);
  if (state.kind === "error") {
    return (
      <TriangleAlert
        size={11}
        aria-label={label}
        className="shrink-0 text-danger"
      />
    );
  }
  const cls = {
    connected: "bg-success",
    // 반쯤 찬 원 — 진행 중임을 색 없이도 알 수 있게.
    connecting:
      "border border-warning bg-gradient-to-r from-warning from-50% to-transparent to-50% animate-pulse",
    disconnected: "border border-fg-muted/50",
  }[state.kind];
  return (
    <span
      aria-label={label}
      className={clsx("h-[7px] w-[7px] shrink-0 rounded-full", cls)}
    />
  );
}

// ─────────────────────────── Shared building blocks ───────────────────────────

/** 접기 가능한 섹션 — 헤더 클릭으로 토글, 접었을 때 카운트, 선택적 action 버튼. */
function Section({
  sectionKey,
  title,
  count,
  action,
  children,
  first = false,
}: {
  sectionKey: string;
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
  /** 첫 섹션은 위 여백 없이 — 여백이 섹션을 나누는 장치라 맨 위엔 필요 없다. */
  first?: boolean;
}) {
  const collapsed = useUI((s) => s.collapsed[sectionKey]);
  const toggle = useUI((s) => s.toggleSection);
  // 필터 중에는 접힘을 무시한다 — 접힌 섹션 안에 답이 숨으면 필터가 쓸모없다.
  const filtering = useSidebarFilter((s) => s.q.trim() !== "");
  const open = filtering || !collapsed;
  return (
    <div className={clsx("flex flex-col", !first && "mt-3.5")}>
      {/* 구분선이 아니라 위 여백이 섹션을 나눈다 — border-border 는 bg-subtle 과
          밝기 차가 라이트 7%·다크 6% 라 선으로는 보이지 않는다. 헤더 아래 hairline 은
          제목을 제 본문에 붙여주는 보조 역할. 스크롤해도 제목이 남도록 sticky. */}
      <div className="sticky top-0 z-10 flex h-5 shrink-0 items-center gap-1.5 border-b border-border bg-subtle pl-2 pr-1">
        <button
          type="button"
          onClick={() => toggle(sectionKey)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-fg-muted hover:text-fg"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0" />
          ) : (
            <ChevronRight size={12} className="shrink-0" />
          )}
          <span className="truncate text-meta font-medium uppercase tracking-wider">
            {title}
          </span>
        </button>
        {/* 접혔을 때만 개수 — 펼치면 항목이 보이니 중복. */}
        {!open && count !== undefined && count > 0 && (
          <span className="shrink-0 text-meta text-fg-muted">{count}</span>
        )}
        {action}
      </div>
      {open && <div className="flex flex-col pr-1 pt-1">{children}</div>}
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
      <Plus size={12} />
    </button>
  );
}

/** 빈 상태 한 줄 — 행과 같은 높이/들여쓰기라 목록이 갑자기 좁아 보이지 않는다. */
function Item({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div
      className={clsx(
        "flex min-h-[26px] items-center rounded pl-3.5 pr-2",
        muted && "text-fg-muted",
      )}
    >
      {label}
    </div>
  );
}
