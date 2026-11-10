import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";
import {
  canonPath,
  normalizePath,
  sameLocation,
  sameSource,
} from "@/lib/entryDnd";
import { pathSegments, splitRoot } from "@/lib/paths";
import { patternToMatcher } from "@/lib/glob";
import { pushClosedTabs, popClosedTab, type ClosedTab } from "./closedTabs";

export type PaneId = "left" | "right";
export type SortKey = "name" | "size" | "mtime" | "kind" | "ext";
export type SortOrder = "asc" | "desc";
export type ViewMode = "details" | "grid" | "tiles";

/** Grid 뷰 셀의 목표 폭(px). 컬럼수 계산에 사용 — EntryGrid 와 키보드 네비가 공유. */
export const GRID_CELL_WIDTH = 120;

/** 그리드 폭(px)에서 컬럼 수 계산. EntryGrid 와 useKeyboardNav 가 동일 식 공유. */
export function gridColumns(widthPx: number): number {
  return Math.max(1, Math.floor(widthPx / GRID_CELL_WIDTH));
}

/**
 * 아카이브 브라우즈 컨텍스트 (UI 전용 — Location 모델 아님).
 * 압축 파일을 임시 추출해 그 폴더를 탐색 중일 때만 set. breadcrumb 표시 +
 * "위로" 가 임시 루트에서 원래 폴더(exitTo)로 나가게 하는 데 사용.
 */
export interface ArchiveBrowse {
  /** 아카이브 파일명 (예: `data.zip`) — breadcrumb 라벨. */
  label: string;
  /** 추출된 임시 디렉토리 경로 (이 prefix 밖으로 나가면 컨텍스트 해제). */
  root: string;
  /** 아카이브가 원래 있던 위치 — "위로" 로 빠져나갈 대상. */
  exitTo: Location;
  /**
   * 아카이브 안의 아카이브를 열었으면 바깥 아카이브 문맥 — 안쪽 루트에서 나와
   * 바깥 임시 폴더로 돌아가면 이 문맥(브레드크럼·"위로"·Update)이 되살아난다.
   */
  parent?: ArchiveBrowse | undefined;
}

/**
 * 탭이 기억하는 아카이브 문맥 수 — 뒤로/앞으로로 임시 폴더에 돌아갈 때 쓴다.
 * 배열 길이 상한일 뿐이다: 각 문맥이 바깥 문맥(parent)을 잡고 있으므로 실제로 남는
 * 문맥 수는 "이 개수 + 중첩 깊이" 까지다(깊이에 선형). parent 는 바깥 문맥 복원과
 * 세션의 원래 폴더 저장에 필요해 끊지 않는다.
 */
const ARCHIVE_TRAIL_MAX = 20;

/** `loc` 이 아카이브 임시 루트(또는 그 하위)인가 — 같은 소스 + 경로 접두(구분자 경계). */
export function insideArchive(loc: Location, ctx: ArchiveBrowse): boolean {
  if (!sameSource(loc.source, ctx.exitTo.source)) return false;
  const p = canonPath(String(loc.path));
  const r = canonPath(ctx.root);
  return p === r || p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * 이동한 위치에 맞는 아카이브 문맥 — 지금 문맥 → 바깥(parent) 문맥 → 이 탭이
 * 열었던 문맥(뒤로/앞으로) 순서로 찾는다. 없으면 undefined (문맥 해제).
 */
function archiveFor(
  loc: Location,
  cur: ArchiveBrowse | undefined,
  trail: ArchiveBrowse[] | undefined,
): ArchiveBrowse | undefined {
  // 가장 구체적인(루트가 가장 긴) 문맥이 이긴다 — 루트가 겹치면 바깥 문맥으로 Update
  // 하지 않게. 길이가 같으면 지금 문맥 사슬 → 최근에 연 문맥 순서.
  let best: ArchiveBrowse | undefined;
  let bestLen = -1;
  const consider = (a: ArchiveBrowse) => {
    if (!insideArchive(loc, a)) return;
    const len = canonPath(a.root).length;
    if (len > bestLen) {
      best = a;
      bestLen = len;
    }
  };
  for (let a = cur; a; a = a.parent) consider(a);
  for (let i = (trail?.length ?? 0) - 1; i >= 0; i--) consider(trail![i]!);
  return best;
}

/** 아카이브 속 아카이브면 맨 바깥 문맥 — 정리되지 않는 원래 폴더(exitTo)를 가진다. */
export function outermostArchive(a: ArchiveBrowse): ArchiveBrowse {
  let o = a;
  while (o.parent) o = o.parent;
  return o;
}

export interface TabState {
  id: string;
  location: Location;
  entries: Entry[];
  cursorIndex: number;
  selected: Set<string>;
  loadedAt: number;
  sortKey: SortKey;
  sortOrder: SortOrder;
  showHidden: boolean;
  viewMode: ViewMode;
  /** grid 뷰의 현재 컬럼 수. EntryGrid 가 폭 측정 후 보고 — 키보드 ↑↓ 이동폭에 사용. */
  gridCols: number;
  /** listDirectory 진행 중 — 느린 원격 탐색에서 "멈춘 것처럼 보임" 방지 스피너용. */
  loading: boolean;
  filter: string;
  filterFocused: boolean;
  /** "크기 계산"으로 구한 폴더 재귀 크기(name → bytes). 다른 폴더로 이동 시 리셋. */
  dirSizes: Record<string, number>;
  history: { stack: Location[]; index: number };
  /** 아카이브 내부 탐색 중이면 set, 아니면 undefined. */
  archive?: ArchiveBrowse | undefined;
  /** 이 탭에서 연 아카이브 문맥들(오래된 것부터) — 뒤로/앞으로로 돌아가면 복원. */
  archiveTrail?: ArchiveBrowse[] | undefined;
  /** 휴지통 탐색 중이면 휴지통 루트 경로 — "Put back" 노출 + 떠나면 해제. */
  trashRoot?: string | undefined;
  /**
   * 고정(핀) 탭. 패널의 탭 배열에서 **항상 앞쪽 연속 구간**에 모인다(불변식 —
   * 모든 삽입·이동이 `pinnedCount` 경계를 지킨다). 실수 닫기(X·가운데 클릭·Ctrl+W·
   * 일괄 닫기)에서 보호되고 세션에 저장된다. 핀 탭 안에서의 폴더 이동은 자유.
   */
  pinned: boolean;
}

export interface PaneState {
  tabs: TabState[];
  activeTabIndex: number;
}

interface PanesState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  // tab management
  /**
   * 새 탭. `location` 생략 시 활성 탭 위치(아카이브·휴지통 문맥 포함)를 연다.
   * `after` 를 주면 그 탭 바로 오른쪽에, 아니면 맨 끝에 넣는다 (Ctrl+T 는 브라우저처럼 끝).
   */
  openTab: (id: PaneId, location?: Location, opts?: { after?: number }) => void;
  /** 탭 하나 닫기. 핀 탭·마지막 한 장은 닫지 않고 false (호출부가 안내). */
  closeTab: (id: PaneId, index: number) => boolean;
  /** `index` 와 핀 탭만 남기고 나머지를 닫는다 (탭 우클릭 "다른 탭 모두 닫기"). */
  closeOtherTabs: (id: PaneId, index: number) => void;
  /** `index` 오른쪽의 고정 안 된 탭들을 닫는다. */
  closeTabsToRight: (id: PaneId, index: number) => void;
  /**
   * 핀이 있으면 고정 안 된 탭을 모두 닫는다. 핀이 없으면 활성 탭만 남긴다
   * (패널은 탭이 최소 1개 필요) — 어느 탭에서 눌러도 결과가 같다.
   */
  closeAllTabs: (id: PaneId) => void;
  /**
   * 탭 복제 — 위치·정렬·보기·숨김·히스토리·아카이브/휴지통 문맥을 그대로 가진 일반
   * 탭을 원본 바로 오른쪽(핀 구간 밖)에 만들고 활성화한다.
   */
  duplicateTab: (id: PaneId, index: number) => void;
  /** 고정/고정 해제 — 핀하면 핀 구간 끝으로, 해제하면 일반 구간 맨 앞으로 간다. */
  togglePinTab: (id: PaneId, index: number) => void;
  /**
   * 드래그로 정한 새 순서(탭 id 배열) 적용. 핀 경계를 넘는 배치는 stable partition
   * 으로 바로잡는다 — 일반 탭을 핀 사이에 떨궈도 핀 구간 바로 뒤에 놓인다.
   */
  reorderTabs: (id: PaneId, orderedIds: string[]) => void;
  /** 탭을 한 칸 왼쪽(-1)/오른쪽(+1)으로. 핀 경계는 넘지 않는다 (키보드 이동). */
  moveTab: (id: PaneId, index: number, delta: -1 | 1) => void;
  /** 가장 최근에 닫은 탭을 원래 패널·자리에 다시 연다. 열었으면 true. */
  reopenClosedTab: () => boolean;
  selectTab: (id: PaneId, index: number) => void;
  // existing — 활성 탭에 dispatch
  setEntries: (
    id: PaneId,
    location: Location,
    entries: Entry[],
    opts?: {
      pushHistory?: boolean;
      focusName?: string;
      /**
       * 이 목록을 요청한 탭 id. 주면 **그 탭에만** 적용하고, 그 탭이 닫혔으면 버린다.
       * 비동기 목록이 도착하는 사이 탭이 닫히거나 바뀌면 남은 탭의 경로·목록이
       * 다른 탭의 결과로 덮어써졌다. 생략하면 활성 탭(예전 동작).
       */
      tabId?: string;
      /**
       * 뒤로/앞으로 이동 확정 — `pushHistory: false` 와 함께, 히스토리 index 를 이 칸으로.
       * 그 칸이 이 위치가 아니면(그사이 히스토리가 바뀜) 무시한다.
       */
      historyIndex?: number;
    },
  ) => void;
  setActivePane: (id: PaneId) => void;
  moveCursor: (id: PaneId, delta: number) => void;
  setCursor: (id: PaneId, index: number) => void;
  toggleSelected: (id: PaneId, name: string) => void;
  /** 선택 집합을 names 로 교체 (마키 드래그 선택용). */
  setSelected: (id: PaneId, names: string[]) => void;
  /** displayed 인덱스 [from..to] 구간을 선택 (Shift+↑↓/Home/End 범위 선택). ".." 제외. */
  selectRange: (id: PaneId, from: number, to: number) => void;
  /** 표시 중인 항목 전체 선택 (".." 제외). */
  selectAll: (id: PaneId) => void;
  /** 선택 반전 (".." 제외). */
  invertSelection: (id: PaneId) => void;
  /** glob/substring 패턴에 맞는 표시 항목을 선택집합에 추가/해제 (".." 제외).
   *  영향받은(매치된) 항목 수를 반환 — 호출부 토스트 피드백용. */
  selectByPattern: (
    id: PaneId,
    pattern: string,
    mode: "add" | "remove",
  ) => number;
  clearSelection: (id: PaneId) => void;
  setSort: (id: PaneId, key: SortKey, order: SortOrder) => void;
  toggleSortKey: (id: PaneId, key: SortKey) => void;
  toggleShowHidden: (id: PaneId) => void;
  setViewMode: (id: PaneId, mode: ViewMode) => void;
  cycleViewMode: (id: PaneId) => void;
  setGridCols: (id: PaneId, cols: number) => void;
  /** 디렉토리 로드 시작/종료 표시 — navigate 가 set, setEntries 가 자동 해제. */
  setLoading: (id: PaneId, loading: boolean, tabId?: string) => void;
  setFilter: (id: PaneId, filter: string) => void;
  setFilterFocused: (id: PaneId, focused: boolean) => void;
  /** 아카이브 브라우즈 컨텍스트 설정/해제 (진입 시 set, null=해제). */
  setArchiveContext: (
    id: PaneId,
    ctx: ArchiveBrowse | null,
    tabId?: string,
  ) => void;
  /** 휴지통 루트 설정/해제 (휴지통 이동 시 set). */
  setTrashRoot: (id: PaneId, root: string | null, tabId?: string) => void;
  /** "크기 계산" 결과 기록 — 크기 컬럼에 폴더 재귀 크기 표시. 계산이 비동기라
   *  도착 시점에 탭이 바뀌었을 수 있어 tabId 로 대상 탭을 지정(없어졌으면 무시). */
  setDirSize: (id: PaneId, tabId: string, name: string, bytes: number) => void;
  /**
   * 뒤로(-1)/앞으로(+1) 갈 히스토리 칸을 **엿보기만** 한다 — index 는 옮기지 않는다.
   * 이동이 성공하면 호출부가 `setEntries(..., { historyIndex })` 로 확정한다.
   * 예전엔 먼저 index 를 옮겨, 이동이 실패하면 화면과 히스토리 위치가 어긋났다(browse-23).
   * `from`: 아직 끝나지 않은 뒤로/앞으로가 향하는 칸 — 연타하면 거기서 한 칸 더 간다.
   */
  peekHistory: (
    id: PaneId,
    delta: -1 | 1,
    from?: number,
  ) => { location: Location; index: number; tabId: string } | null;
  /** 좌/우 패널 내용 통째 교환 (포커스 위치는 유지). */
  swapPanes: () => void;
  /** 활성 패널의 현재 탭을 반대 패널로 이동(포커스도 따라감). */
  moveActiveTabToOther: () => void;
  /** 세션 복원 — 저장된 탭 레이아웃(로컬 탭)을 통째로 설정. 부팅 시 1회. */
  restoreLayout: (layout: RestoredLayout) => void;
}

/**
 * 세션 영속용 슬림 레이아웃.
 *
 * 원격 탭은 `host`(alias)로 저장한다 — 재시작하면 연결이 사라져 connection_id 는
 * 무효지만, alias+경로만 있으면 배너의 "다시 연결"이 그 자리로 되돌아갈 수 있다.
 * (예전엔 원격 탭을 통째로 버려서 SSH 작업 문맥이 재시작마다 사라졌다.)
 */
export interface RestoredLayout {
  activePane: PaneId;
  panes: Record<
    PaneId,
    {
      activeTabIndex: number;
      tabs: Array<{
        path: string;
        /** SSH 탭이면 호스트 alias. 없으면 로컬 탭. */
        host?: string;
        sortKey: SortKey;
        sortOrder: SortOrder;
        showHidden: boolean;
        viewMode: ViewMode;
        /** 고정 탭이면 true. 없으면(구버전 세션 포함) 일반 탭. */
        pinned?: boolean;
      }>;
    }
  >;
}

/** 복원된(아직 연결 안 된) 원격 탭의 connection_id 접미사. */
export const RESTORED_CONN = "restored";

/** 이 위치가 복원된 원격 탭인가 — 아직 살아있는 연결이 없다. */
export function isRestoredRemote(loc: Location): boolean {
  return (
    loc.source.kind === "ssh" &&
    loc.source.connection_id.endsWith(`:${RESTORED_CONN}`)
  );
}

const home = (): Location => ({
  source: { kind: "local" },
  path: "/",
});

let _idSeq = 0;
function newTabId(): string {
  _idSeq += 1;
  return `t${_idSeq}`;
}

/** 새 탭 기본값 — 설정(Settings)에서 부팅 시 주입(applyTabDefaults). 죽은 토글 방지 배선. */
let tabDefaults: { sortKey: SortKey; viewMode: ViewMode; showHidden: boolean } =
  {
    sortKey: "mtime",
    viewMode: "details",
    showHidden: false,
  };

/**
 * 키별 첫 정렬 방향 — 수정일·크기는 내림차순(최신/큰 것 먼저)이 자연스럽다.
 * Finder/탐색기도 같은 관례. 같은 키 재클릭은 여전히 방향 토글.
 */
export function defaultOrderFor(key: SortKey): SortOrder {
  return key === "mtime" || key === "size" ? "desc" : "asc";
}

/**
 * 새 탭. 경로는 `setEntries` 와 같은 `normalizePath` 로 저장한다 — 원문(`/a/`,
 * `C:\a\`, `\\srv\share\`)을 그대로 두면 첫 목록이 정규화된 칸을 히스토리에 한 번 더
 * 쌓고, 뒤로 성공 시 index 확정 검사가 그 칸을 다른 위치로 봤다(R3-1).
 */
const initialTab = (raw: Location = home()): TabState => {
  const location: Location = { ...raw, path: normalizePath(raw.path) };
  return {
    id: newTabId(),
    location,
    entries: [],
    cursorIndex: -1,
    selected: new Set(),
    loadedAt: 0,
    sortKey: tabDefaults.sortKey,
    sortOrder: defaultOrderFor(tabDefaults.sortKey),
    showHidden: tabDefaults.showHidden,
    viewMode: tabDefaults.viewMode,
    gridCols: 1,
    loading: false,
    filter: "",
    filterFocused: false,
    dirSizes: {},
    history: { stack: [location], index: 0 },
    pinned: false,
  };
};

const initialPane = (): PaneState => ({
  tabs: [initialTab()],
  activeTabIndex: 0,
});

/** active tab 반환 — 외부 helper. */
export function activeTab(state: PanesState, id: PaneId): TabState {
  const p = state.panes[id];
  return p.tabs[p.activeTabIndex] ?? p.tabs[0]!;
}

/**
 * 표시 순서가 바뀌는 변경(정렬·숨김 토글) 뒤에도 커서가 **보던 항목**(이름)을 따라가게.
 * 예전엔 역순 정렬 뒤 커서가 같은 인덱스의 다른 파일에 남거나(Enter·F2·Delete 대상이
 * 바뀜) 맨 위로 튀었다. 항목이 사라졌으면(숨김) 인덱스를 clamp.
 */
function keepCursor(prev: TabState, next: TabState): TabState {
  const name = computeDisplayed(prev)[prev.cursorIndex]?.name;
  const after = computeDisplayed(next);
  const at = name === undefined ? -1 : after.findIndex((e) => e.name === name);
  const cursorIndex =
    at >= 0
      ? at
      : after.length > 0
        ? Math.min(Math.max(0, prev.cursorIndex), after.length - 1)
        : -1;
  return { ...next, cursorIndex };
}

/** 앞쪽 연속 핀 구간의 길이 = 첫 일반 탭의 인덱스. */
export function pinnedCount(p: PaneState): number {
  let k = 0;
  while (k < p.tabs.length && p.tabs[k]!.pinned) k += 1;
  return k;
}

/**
 * 핀 탭을 앞으로 모으는 stable partition — 각 구간 안의 순서는 유지하고, 활성
 * 탭은 **id 로** 따라간다(사라졌으면 `fallbackId`, 그것도 없으면 0).
 */
function arrangePane(
  tabs: TabState[],
  activeId: string | undefined,
  fallbackId?: string,
): PaneState {
  const ordered = [
    ...tabs.filter((t) => t.pinned),
    ...tabs.filter((t) => !t.pinned),
  ];
  let i = ordered.findIndex((t) => t.id === activeId);
  if (i < 0) i = ordered.findIndex((t) => t.id === fallbackId);
  return { tabs: ordered, activeTabIndex: Math.max(0, i) };
}

/** `tabId` 의 탭(생략 시 활성 탭)만 변경 — 그 탭이 없으면(닫힘) 그대로. */
function withTab(
  p: PaneState,
  tabId: string | undefined,
  fn: (t: TabState) => TabState,
): PaneState {
  if (tabId === undefined) return withActiveTab(p, fn);
  const i = p.tabs.findIndex((t) => t.id === tabId);
  const cur = p.tabs[i];
  if (!cur) return p;
  const tabs = p.tabs.slice();
  tabs[i] = fn(cur);
  return { ...p, tabs };
}

/** 일괄 닫기에서 빠진 탭들을 닫은 탭 스택에 기록 (왼쪽부터). */
function recordClosed(id: PaneId, before: TabState[], after: TabState[]): void {
  const kept = new Set(after.map((t) => t.id));
  const closed: ClosedTab[] = [];
  before.forEach((tab, index) => {
    if (!kept.has(tab.id)) closed.push({ pane: id, index, tab });
  });
  pushClosedTabs(closed);
}

/** 액션 안에서 active tab 만 변경하는 헬퍼. */
function withActiveTab(p: PaneState, fn: (t: TabState) => TabState): PaneState {
  const i = p.activeTabIndex;
  const cur = p.tabs[i];
  if (!cur) return p;
  const next = fn(cur);
  if (next === cur) return p;
  const tabs = p.tabs.slice();
  tabs[i] = next;
  return { ...p, tabs };
}

export const usePanes = create<PanesState>((set, get) => ({
  panes: {
    left: initialPane(),
    right: initialPane(),
  },
  activePane: "left",
  openTab: (id, location, opts) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex] ?? p.tabs[0]!;
      const nt = initialTab(location ?? cur.location);
      // 위치를 안 주면 현재 탭 자리를 연다 — 아카이브/휴지통 안이면 그 문맥도
      // 함께 가져가야 "위로"가 원래 폴더로 나가고 임시 경로가 세션에 남지 않는다.
      // 위치를 줬어도 같은 아카이브/휴지통 안(예: 아카이브 속 폴더를 Ctrl+↑)이면
      // 문맥을 유지한다.
      const path = String(nt.location.path);
      if (
        !location ||
        (cur.archive && insideArchive(nt.location, cur.archive))
      ) {
        nt.archive = cur.archive;
        // 기억한 문맥도 함께 — 새 탭에서 나갔다가 뒤로 돌아와도 문맥이 되살아나게.
        nt.archiveTrail = cur.archiveTrail;
      }
      if (!location || (cur.trashRoot && path.startsWith(cur.trashRoot)))
        nt.trashRoot = cur.trashRoot;
      // 새 탭은 일반 탭 — 핀 구간 안으로는 들어가지 않는다.
      const at = Math.max(
        pinnedCount(p),
        opts?.after === undefined
          ? p.tabs.length
          : Math.min(Math.max(0, opts.after + 1), p.tabs.length),
      );
      const tabs = [...p.tabs.slice(0, at), nt, ...p.tabs.slice(at)];
      return {
        panes: { ...s.panes, [id]: { tabs, activeTabIndex: at } },
      };
    }),
  closeTab: (id, index) => {
    const p = get().panes[id];
    const target = p.tabs[index];
    // 핀 탭은 X·가운데 클릭·Ctrl+W·팔레트 어느 경로로도 닫히지 않는다 — 가드를
    // 여기(store)에 둬야 키맵·팔레트 경로가 새지 않는다.
    if (!target || target.pinned || p.tabs.length <= 1) return false;
    pushClosedTabs([{ pane: id, index, tab: target }]);
    set((s) => {
      const tabs = p.tabs.slice();
      tabs.splice(index, 1);
      let next = p.activeTabIndex;
      if (index === p.activeTabIndex) {
        next = Math.max(0, index - 1);
      } else if (index < p.activeTabIndex) {
        next = p.activeTabIndex - 1;
      }
      return { panes: { ...s.panes, [id]: { tabs, activeTabIndex: next } } };
    });
    return true;
  },
  closeOtherTabs: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      const target = p.tabs[index];
      if (!target) return s;
      const tabs = p.tabs.filter((t, i) => i === index || t.pinned);
      if (tabs.length === p.tabs.length) return s;
      recordClosed(id, p.tabs, tabs);
      // 누른 탭이 활성이 된다 (브라우저 관례).
      return {
        panes: {
          ...s.panes,
          [id]: { tabs, activeTabIndex: tabs.indexOf(target) },
        },
      };
    }),
  closeTabsToRight: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      const target = p.tabs[index];
      if (!target) return s;
      const tabs = p.tabs.filter((t, i) => i <= index || t.pinned);
      if (tabs.length === p.tabs.length) return s;
      recordClosed(id, p.tabs, tabs);
      // 활성 탭이 남았으면 그대로, 닫혔으면 기준 탭으로 옮겨온다.
      const activeId = p.tabs[p.activeTabIndex]?.id;
      return {
        panes: { ...s.panes, [id]: arrangePane(tabs, activeId, target.id) },
      };
    }),
  closeAllTabs: (id) =>
    set((s) => {
      const p = s.panes[id];
      const active = p.tabs[p.activeTabIndex] ?? p.tabs[0];
      if (!active) return s;
      const pinned = p.tabs.filter((t) => t.pinned);
      // 핀이 있으면 핀만 남기고(활성이 일반 탭이었으면 마지막 핀으로), 없으면 패널은
      // 탭이 최소 1개 필요하므로 보고 있던 탭을 남긴다.
      const tabs = pinned.length > 0 ? pinned : [active];
      if (tabs.length === p.tabs.length) return s;
      recordClosed(id, p.tabs, tabs);
      const fallback = tabs[tabs.length - 1]!.id;
      return {
        panes: { ...s.panes, [id]: arrangePane(tabs, active.id, fallback) },
      };
    }),
  duplicateTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      const src = p.tabs[index];
      if (!src) return s;
      const copy: TabState = {
        ...src,
        id: newTabId(),
        selected: new Set(),
        loading: false,
        filter: "",
        filterFocused: false,
        dirSizes: {},
        history: { stack: src.history.stack.slice(), index: src.history.index },
        pinned: false,
      };
      const at = Math.max(pinnedCount(p), index + 1);
      const tabs = [...p.tabs.slice(0, at), copy, ...p.tabs.slice(at)];
      return { panes: { ...s.panes, [id]: { tabs, activeTabIndex: at } } };
    }),
  togglePinTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      const target = p.tabs[index];
      if (!target) return s;
      const tabs = p.tabs.map((t, i) =>
        i === index ? { ...t, pinned: !t.pinned } : t,
      );
      // 핀 구간이 항상 앞쪽이므로 stable partition 만으로 "핀 = 핀 구간 끝,
      // 해제 = 일반 구간 맨 앞" 이 된다.
      const activeId = p.tabs[p.activeTabIndex]?.id;
      return { panes: { ...s.panes, [id]: arrangePane(tabs, activeId) } };
    }),
  selectTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      if (index < 0 || index >= p.tabs.length) return s;
      return { panes: { ...s.panes, [id]: { ...p, activeTabIndex: index } } };
    }),
  reorderTabs: (id, orderedIds) =>
    set((s) => {
      const p = s.panes[id];
      const byId = new Map(p.tabs.map((t) => [t.id, t]));
      const listed = orderedIds
        .map((tid) => byId.get(tid))
        .filter((t): t is TabState => t !== undefined);
      const rest = p.tabs.filter((t) => !orderedIds.includes(t.id));
      const next = arrangePane(
        [...listed, ...rest],
        p.tabs[p.activeTabIndex]?.id,
      );
      if (next.tabs.every((t, i) => t === p.tabs[i])) return s;
      return { panes: { ...s.panes, [id]: next } };
    }),
  moveTab: (id, index, delta) =>
    set((s) => {
      const p = s.panes[id];
      const a = p.tabs[index];
      const b = p.tabs[index + delta];
      // 핀 경계를 넘는 이동은 하지 않는다 (불변식).
      if (!a || !b || a.pinned !== b.pinned) return s;
      const tabs = p.tabs.slice();
      tabs[index] = b;
      tabs[index + delta] = a;
      const activeId = p.tabs[p.activeTabIndex]?.id;
      return { panes: { ...s.panes, [id]: arrangePane(tabs, activeId) } };
    }),
  reopenClosedTab: () => {
    const c = popClosedTab();
    if (!c) return false;
    set((s) => {
      const p = s.panes[c.pane];
      const pc = pinnedCount(p);
      // 아카이브 임시 추출 폴더는 그사이 정리됐을 수 있다 — 원래 폴더로 연다.
      const base = c.tab.archive
        ? {
            ...c.tab,
            // 아카이브 속 아카이브면 안쪽 exitTo 도 임시 폴더 — 맨 바깥 원래 폴더로.
            location: outermostArchive(c.tab.archive).exitTo,
            archive: undefined,
            archiveTrail: undefined,
          }
        : c.tab;
      const tab: TabState = {
        ...base,
        id: newTabId(),
        entries: [],
        selected: new Set(),
        loading: false,
        cursorIndex: -1,
        history: c.tab.archive
          ? { stack: [outermostArchive(c.tab.archive).exitTo], index: 0 }
          : c.tab.history,
      };
      // 원래 자리 근처로 — 단 핀/일반 구간 경계는 지킨다.
      const at = tab.pinned
        ? Math.min(c.index, pc)
        : Math.min(Math.max(c.index, pc), p.tabs.length);
      const tabs = [...p.tabs.slice(0, at), tab, ...p.tabs.slice(at)];
      return {
        panes: { ...s.panes, [c.pane]: { tabs, activeTabIndex: at } },
        activePane: c.pane,
      };
    });
    return true;
  },
  setEntries: (id, location, entries, opts) =>
    set((s) => {
      // 저장 전 경로 정규화 — C:\/ 등 혼합/중복 구분자를 네이티브로(표시·영속 일관).
      const loc: Location = { ...location, path: normalizePath(location.path) };
      const p = s.panes[id];
      const targetIndex =
        opts?.tabId === undefined
          ? p.activeTabIndex
          : p.tabs.findIndex((t) => t.id === opts.tabId);
      const cur = p.tabs[targetIndex];
      if (!cur) return s;
      // 경로뿐 아니라 소스(로컬/어느 연결)까지 같아야 "같은 폴더 새로고침" — 로컬
      // /var/log 에서 원격 /var/log 로 가면 이동이다(히스토리·선택·필터 초기화).
      const navigated = !sameLocation(cur.location, loc);
      const pushHistory = opts?.pushHistory ?? true;
      let history = cur.history;
      if (navigated && pushHistory) {
        const stack = history.stack.slice(0, history.index + 1);
        stack.push(loc);
        const trimmed =
          stack.length > 100 ? stack.slice(stack.length - 100) : stack;
        history = { stack: trimmed, index: trimmed.length - 1 };
      } else if (opts?.historyIndex !== undefined) {
        const at = history.stack[opts.historyIndex];
        // 옛 세션 등 정규화 전에 쌓인 칸도 같은 위치로 본다.
        if (at && sameLocation({ ...at, path: normalizePath(at.path) }, loc))
          history = { ...history, index: opts.historyIndex };
      }
      // 아카이브/휴지통 루트 밖으로 이동하면 컨텍스트 해제 (내부 하위폴더면 유지).
      // 바깥 아카이브로 돌아가거나(아카이브 속 아카이브) 뒤로/앞으로로 임시 폴더에
      // 돌아오면 그 문맥을 되살린다 — 예전엔 임시 경로가 그대로 보이고 "위로"가
      // 시스템 temp 로 올라갔으며 Update 버튼이 사라졌다 (archive-15·browse-32).
      const archive = archiveFor(loc, cur.archive, cur.archiveTrail);
      const trashRoot =
        cur.trashRoot && loc.path.startsWith(cur.trashRoot)
          ? cur.trashRoot
          : undefined;
      // 같은 폴더 새로고침이면 커서와 선택을 유지한다.
      //
      // 예전엔 무조건 커서를 0 으로 되돌렸다 — 그런데 EntryList 가 커서로
      // scrollToIndex 하므로, 감시자가 이벤트를 하나 던질 때마다 목록이 맨 위로
      // 튀었다. 리눅스 inotify 는 특히 자주 뜬다(미리보기가 파일을 읽기만 해도
      // IN_ATTRIB). 스크롤해서 아래 항목을 누르려는 순간 위로 튀어 오르던 버그.
      //
      // 커서는 **이름**으로 따라간다 — 새로고침 사이에 항목이 추가/삭제돼 인덱스가
      // 밀려도 보던 항목에 그대로 남게. 그 항목이 사라졌으면 인덱스를 clamp.
      let cursorIndex: number;
      let selected: Set<string>;
      if (navigated) {
        selected = new Set();
        // 상위로 갈 때는 **떠나온 폴더**에 커서를 놓는다(TC·DOpus·탐색기 관례).
        // 예전엔 무조건 0 이라, 위로 간 직후 커서가 ".." 에 앉아 Enter 를 누르면
        // 또 위로 갔고, 형제 폴더를 오가는 작업마다 커서를 다시 찾아야 했다.
        const focusName = opts?.focusName;
        // 이동하면 필터가 풀리므로(아래 nextTab) 같은 조건의 목록에서 찾는다.
        const displayed = computeDisplayed({
          ...cur,
          entries,
          location: loc,
          filter: "",
        });
        const at =
          focusName === undefined
            ? -1
            : displayed.findIndex((e) => e.name === focusName);
        cursorIndex = at >= 0 ? at : entries.length > 0 ? 0 : -1;
      } else {
        const names = new Set(entries.map((e) => e.name));
        selected = new Set([...cur.selected].filter((n) => names.has(n)));
        const focused = computeDisplayed(cur)[cur.cursorIndex]?.name;
        const after = computeDisplayed({ ...cur, entries, location: loc });
        const found =
          focused === undefined
            ? -1
            : after.findIndex((e) => e.name === focused);
        cursorIndex =
          found >= 0
            ? found
            : after.length > 0
              ? Math.min(Math.max(0, cur.cursorIndex), after.length - 1)
              : -1;
      }
      const nextTab: TabState = {
        ...cur,
        location: loc,
        entries,
        cursorIndex,
        selected,
        loading: false,
        loadedAt: Date.now(),
        filter: navigated ? "" : cur.filter,
        filterFocused: navigated ? false : cur.filterFocused,
        // 같은 폴더 새로고침이면 계산해둔 폴더 크기 유지(약간 낡을 수 있음 — TC 동일).
        dirSizes: navigated ? {} : cur.dirSizes,
        history,
        archive,
        trashRoot,
      };
      const tabs = p.tabs.slice();
      tabs[targetIndex] = nextTab;
      return { panes: { ...s.panes, [id]: { ...p, tabs } } };
    }),
  setActivePane: (id) => set({ activePane: id }),
  restoreLayout: (layout) =>
    set(() => {
      const buildPane = (slim: RestoredLayout["panes"][PaneId]): PaneState => {
        const tabs: TabState[] = slim.tabs.map((t) => ({
          ...initialTab(
            t.host
              ? {
                  // 죽은 연결을 가리키는 자리표시자 — 패널이 "연결 끊김" 배너를
                  // 띄우고, 거기서 alias 로 다시 연결하면 이 경로로 돌아온다.
                  source: {
                    kind: "ssh",
                    connection_id: `${t.host}:${RESTORED_CONN}`,
                    host_ip: "0.0.0.0",
                    user: "",
                  },
                  path: t.path,
                }
              : {
                  source: { kind: "local" },
                  path: normalizePath(t.path),
                },
          ),
          sortKey: t.sortKey,
          sortOrder: t.sortOrder,
          showHidden: t.showHidden,
          viewMode: t.viewMode,
          pinned: t.pinned === true,
        }));
        if (tabs.length === 0) return initialPane();
        const activeTabIndex = Math.min(
          Math.max(0, slim.activeTabIndex),
          tabs.length - 1,
        );
        // 손으로 고친/섞인 데이터 대비 핀 구간을 다시 맞춘다 — 저장된 활성 탭은
        // 정렬 전에 잡아 둔 id 로 따라간다(인덱스를 먼저 쓰면 다른 탭이 활성이 됨).
        return arrangePane(tabs, tabs[activeTabIndex]?.id);
      };
      return {
        panes: {
          left: buildPane(layout.panes.left),
          right: buildPane(layout.panes.right),
        },
        activePane: layout.activePane,
      };
    }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex];
      if (!cur) return s;
      const visible = computeDisplayed(cur);
      const next = Math.max(
        0,
        Math.min(visible.length - 1, cur.cursorIndex + delta),
      );
      return {
        panes: {
          ...s.panes,
          [id]: withActiveTab(p, (t) => ({ ...t, cursorIndex: next })),
        },
      };
    }),
  setCursor: (id, index) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, cursorIndex: index })),
      },
    })),
  selectRange: (id, from, to) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          const visible = computeDisplayed(t);
          const lo = Math.max(0, Math.min(from, to));
          const hi = Math.min(visible.length - 1, Math.max(from, to));
          const sel = new Set<string>();
          for (let i = lo; i <= hi; i++) {
            const e = visible[i];
            if (e && !isParentEntry(e)) sel.add(e.name);
          }
          return { ...t, selected: sel };
        }),
      },
    })),
  selectAll: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          selected: new Set(
            computeDisplayed(t)
              .filter((e) => !isParentEntry(e))
              .map((e) => e.name),
          ),
        })),
      },
    })),
  invertSelection: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          const sel = new Set<string>();
          for (const e of computeDisplayed(t)) {
            if (!isParentEntry(e) && !t.selected.has(e.name)) sel.add(e.name);
          }
          return { ...t, selected: sel };
        }),
      },
    })),
  toggleSelected: (id, name) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          const sel = new Set(t.selected);
          if (sel.has(name)) sel.delete(name);
          else sel.add(name);
          return { ...t, selected: sel };
        }),
      },
    })),
  setSelected: (id, names) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          selected: new Set(names),
        })),
      },
    })),
  selectByPattern: (id, pattern, mode) => {
    const matcher = patternToMatcher(pattern);
    // 표시 항목(필터/숨김/정렬 반영분) 중 매치 — 합성 ".." 행은 제외.
    const t = activeTab(get(), id);
    const matched = computeDisplayed(t).filter(
      (e) => !isParentEntry(e) && matcher(e.name),
    );
    // add 는 매치 전부, remove 는 현재 선택된 것만 실제 영향.
    const affected =
      mode === "add"
        ? matched.length
        : matched.filter((e) => t.selected.has(e.name)).length;
    if (matched.length === 0) return 0;
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (tt) => {
          const sel = new Set(tt.selected);
          for (const e of matched) {
            if (mode === "add") sel.add(e.name);
            else sel.delete(e.name);
          }
          // add 시 첫 매치로 커서 이동 → 가상 스크롤이 뷰포트로 끌어와 가시화.
          let cursorIndex = tt.cursorIndex;
          if (mode === "add" && matched[0]) {
            const firstName = matched[0].name;
            const disp = computeDisplayed(tt);
            const first = disp.findIndex((e) => e.name === firstName);
            if (first >= 0) cursorIndex = first;
          }
          return { ...tt, selected: sel, cursorIndex };
        }),
      },
    }));
    return affected;
  },
  clearSelection: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          selected: new Set(),
        })),
      },
    })),
  setSort: (id, key, order) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) =>
          keepCursor(t, { ...t, sortKey: key, sortOrder: order }),
        ),
      },
    })),
  toggleSortKey: (id, key) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) =>
          keepCursor(
            t,
            t.sortKey === key
              ? { ...t, sortOrder: t.sortOrder === "asc" ? "desc" : "asc" }
              : { ...t, sortKey: key, sortOrder: defaultOrderFor(key) },
          ),
        ),
      },
    })),
  toggleShowHidden: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          // 커서는 이름으로 따라간다 — 1클릭 토글마다 맨 위로 튀지 않게.
          const next = keepCursor(t, { ...t, showHidden: !t.showHidden });
          // 숨겨진 항목이 선택에 남으면 보이지 않는 파일이 삭제·이동 대상이 된다.
          const visible = new Set(computeDisplayed(next).map((e) => e.name));
          const selected = new Set(
            [...t.selected].filter((n) => visible.has(n)),
          );
          return { ...next, selected };
        }),
      },
    })),
  setViewMode: (id, mode) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) =>
          t.viewMode === mode ? t : { ...t, viewMode: mode },
        ),
      },
    })),
  cycleViewMode: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          const order: ViewMode[] = ["details", "grid", "tiles"];
          const next = order[(order.indexOf(t.viewMode) + 1) % order.length]!;
          return { ...t, viewMode: next };
        }),
      },
    })),
  setGridCols: (id, cols) =>
    set((s) => {
      const c = Math.max(1, cols);
      return {
        panes: {
          ...s.panes,
          [id]: withActiveTab(s.panes[id], (t) =>
            t.gridCols === c ? t : { ...t, gridCols: c },
          ),
        },
      };
    }),
  setLoading: (id, loading, tabId) =>
    set((s) => {
      const p = s.panes[id];
      // tabId 가 있으면 그 탭(활성이 아니어도), 없으면 활성 탭.
      const i =
        tabId === undefined
          ? p.activeTabIndex
          : p.tabs.findIndex((t) => t.id === tabId);
      const cur = p.tabs[i];
      if (!cur || cur.loading === loading) return s;
      const tabs = p.tabs.slice();
      tabs[i] = { ...cur, loading };
      return { panes: { ...s.panes, [id]: { ...p, tabs } } };
    }),
  setFilter: (id, filter) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          const next = { ...t, filter, cursorIndex: 0 };
          // 필터에 가려진 항목이 선택에 남으면 보이지 않는 파일이 복사·이동·삭제
          // 대상이 된다 — 숨김 토글과 같은 정책으로 보이는 이름만 남긴다.
          const visible = new Set(computeDisplayed(next).map((e) => e.name));
          const selected = new Set(
            [...t.selected].filter((n) => visible.has(n)),
          );
          return { ...next, selected };
        }),
      },
    })),
  setFilterFocused: (id, focused) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          filterFocused: focused,
        })),
      },
    })),
  setArchiveContext: (id, ctx, tabId) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withTab(s.panes[id], tabId, (t) => {
          if (!ctx) return { ...t, archive: undefined };
          // 아카이브 안에서 또 아카이브를 열었으면(나갈 곳이 바깥 임시 폴더) 바깥
          // 문맥을 parent 로 잇는다 — 안쪽에서 나오면 바깥 문맥이 돌아온다.
          const outer =
            ctx.parent ?? archiveFor(ctx.exitTo, t.archive, t.archiveTrail);
          const archive: ArchiveBrowse = outer
            ? { ...ctx, parent: outer }
            : ctx;
          const trail = (t.archiveTrail ?? []).filter(
            (a) => a.root !== archive.root,
          );
          trail.push(archive);
          return {
            ...t,
            archive,
            archiveTrail: trail.slice(-ARCHIVE_TRAIL_MAX),
          };
        }),
      },
    })),
  setDirSize: (id, tabId, name, bytes) =>
    set((s) => {
      const p = s.panes[id];
      const i = p.tabs.findIndex((t) => t.id === tabId);
      const cur = p.tabs[i];
      if (!cur) return s;
      const tabs = p.tabs.slice();
      // 크기 정렬이면 순서가 바뀔 수 있다 — 커서는 보던 항목을 따라간다.
      tabs[i] = keepCursor(cur, {
        ...cur,
        dirSizes: { ...cur.dirSizes, [name]: bytes },
      });
      return { panes: { ...s.panes, [id]: { ...p, tabs } } };
    }),
  setTrashRoot: (id, root, tabId) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withTab(s.panes[id], tabId, (t) => ({
          ...t,
          trashRoot: root ?? undefined,
        })),
      },
    })),
  peekHistory: (id, delta, from) => {
    const p = get().panes[id];
    const cur = p.tabs[p.activeTabIndex];
    if (!cur) return null;
    const index = (from ?? cur.history.index) + delta;
    const location = cur.history.stack[index];
    if (!location) return null;
    return { location, index, tabId: cur.id };
  },
  swapPanes: () =>
    set((s) => ({
      // 내용만 교환 — 포커스(activePane)는 그대로라 같은 쪽에 swap 된 내용이 보인다.
      panes: { left: s.panes.right, right: s.panes.left },
    })),
  moveActiveTabToOther: () =>
    set((s) => {
      const from = s.activePane;
      const to: PaneId = from === "left" ? "right" : "left";
      const src = s.panes[from];
      const dst = s.panes[to];
      const tab = src.tabs[src.activeTabIndex];
      if (!tab) return s;
      // 소스에서 제거 — 마지막 1개였으면 빈 split 방지 위해 fresh tab 으로 대체.
      let srcTabs = src.tabs.slice();
      srcTabs.splice(src.activeTabIndex, 1);
      let srcActive = Math.max(0, src.activeTabIndex - 1);
      if (srcTabs.length === 0) {
        srcTabs = [initialTab()];
        srcActive = 0;
      }
      // 핀 탭은 핀인 채로 상대 패널 핀 구간 끝에, 일반 탭은 맨 끝에.
      const at = tab.pinned ? pinnedCount(dst) : dst.tabs.length;
      const dstTabs = [...dst.tabs.slice(0, at), tab, ...dst.tabs.slice(at)];
      return {
        panes: {
          ...s.panes,
          [from]: { tabs: srcTabs, activeTabIndex: srcActive },
          [to]: { tabs: dstTabs, activeTabIndex: at },
        },
        activePane: to, // 이동한 탭을 따라 포커스 이동
      };
    }),
}));

/** 표시 entries — 활성 탭 기준. raw → filter → hidden → sort. */
export function selectDisplayedEntries(id: PaneId, state: PanesState): Entry[] {
  const t = activeTab(state, id);
  return computeDisplayed(t);
}

/** 최상단 부모 이동 행의 sentinel 이름. */
export const PARENT_NAME = "..";

/** 합성 ".." 항목 (실제 listing 엔 절대 없는 이름이라 sentinel 안전). */
const PARENT_ENTRY: Entry = {
  name: PARENT_NAME,
  kind: "dir",
  size: null,
  modified_ms: null,
  permissions: null,
  hidden: false,
};

/** entry 가 합성 ".." 부모 행인지. 작업/선택 대상에서 제외하는 가드용. */
export function isParentEntry(e: Entry): boolean {
  return e.name === PARENT_NAME;
}

/**
 * 경로가 최상위 루트인지 — 위로 갈 부모가 없는 곳. `..` 행을 숨길지 판단.
 * 루트 규칙은 `splitRoot` 하나를 따른다: `/`, `C:\`·`C:`, UNC `\\srv\share`,
 * `\\?\C:\`, `\\?\UNC\srv\share`.
 */
export function isRootPath(p: string): boolean {
  if (p.length === 0) return true;
  const r = splitRoot(p);
  return r !== null && pathSegments(r.rest).length === 0;
}

export function computeDisplayed(t: TabState): Entry[] {
  let arr = t.entries;
  if (t.filter.length > 0) {
    const q = t.filter.toLowerCase();
    arr = arr.filter((e) => e.name.toLowerCase().includes(q));
  }
  if (!t.showHidden) {
    arr = arr.filter((e) => !e.hidden);
  }
  const sorted = sortEntries(arr, t.sortKey, t.sortOrder, t.dirSizes);
  // 루트가 아니고 필터가 없을 때만 최상단에 ".." (부모/아카이브 나가기) 행.
  // 정렬과 무관하게 항상 맨 위 고정. 빈 폴더에서도 돌아갈 수 있게 표시.
  // (아카이브/휴지통 임시 루트는 드라이브 루트가 아니라 isRootPath=false → ".." 유지.)
  if (!isRootPath(t.location.path) && t.filter.length === 0) {
    return [PARENT_ENTRY, ...sorted];
  }
  return sorted;
}

/**
 * 이름 비교기 — **자연 정렬**(numeric): `img_2` 가 `img_10` 앞에 온다.
 * `localeCompare` 는 문자열 비교라 사진·로그 폴더에서 순서가 뒤집혀 보였다.
 * 모듈 레벨 1회 생성 — 비교마다 만들면 큰 폴더 정렬이 눈에 띄게 느려진다.
 */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/**
 * 폴더를 항상 위에 둘지 — 설정(`dirs_first`) 미러. DESIGN.md 는 처음부터
 * "설정으로 변경 가능" 이라 했는데 코드엔 하드코딩돼 있었다(최근 수정순으로
 * 폴더·파일을 섞어 보는 게 불가능했다).
 */
let dirsFirstEnabled = true;

export function setDirsFirst(v: boolean): void {
  dirsFirstEnabled = v;
}

function sortEntries(
  entries: Entry[],
  key: SortKey,
  order: SortOrder,
  dirSizes: Record<string, number>,
): Entry[] {
  const dirsFirst = (a: Entry, b: Entry) => {
    if (!dirsFirstEnabled) return 0;
    if (a.kind !== b.kind) {
      if (a.kind === "dir") return -1;
      if (b.kind === "dir") return 1;
    }
    return 0;
  };
  const cmpName = (a: Entry, b: Entry) => collator.compare(a.name, b.name);
  // 폴더는 "크기 계산" 결과가 있으면 그 값으로 — 표시되는 크기와 정렬 순서를 맞춘다.
  const sizeOf = (e: Entry) =>
    (e.kind === "dir" ? dirSizes[e.name] : undefined) ?? e.size ?? 0;
  const cmpExt = (a: Entry, b: Entry) => {
    const ax = a.name.lastIndexOf(".");
    const bx = b.name.lastIndexOf(".");
    const ae = ax >= 0 ? a.name.slice(ax + 1) : "";
    const be = bx >= 0 ? b.name.slice(bx + 1) : "";
    return collator.compare(ae, be) || cmpName(a, b);
  };
  const cmpKey = (a: Entry, b: Entry): number => {
    switch (key) {
      case "name":
        return cmpName(a, b);
      case "size":
        return sizeOf(a) - sizeOf(b) || cmpName(a, b);
      case "mtime":
        return (a.modified_ms ?? 0) - (b.modified_ms ?? 0) || cmpName(a, b);
      case "kind":
        return a.kind.localeCompare(b.kind) || cmpName(a, b);
      case "ext":
        return cmpExt(a, b);
    }
  };
  const sorted = [...entries].sort((a, b) => {
    const df = dirsFirst(a, b);
    if (df !== 0) return df;
    const c = cmpKey(a, b);
    return order === "asc" ? c : -c;
  });
  return sorted;
}

/**
 * 설정에서 새 탭 기본값을 주입하고, `existing`(기본 true)이면 지금 열린 모든 탭에도
 * 적용한다 — 설정 화면에서 "default view" 등을 바꾸면 바로 반영되게.
 *
 * 부팅 때 세션을 복원했으면 `existing: false` 로 부른다. 세션은 탭마다 정렬·보기·
 * 숨김을 저장하는데, 예전엔 부팅 직후 이 함수가 그 값을 전부 기본값으로 덮어써
 * 재시작할 때마다 탭별 설정이 사라졌다.
 */
export function applyTabDefaults(
  d: {
    sortKey: SortKey;
    viewMode: ViewMode;
    showHidden: boolean;
  },
  opts: { existing?: boolean } = {},
): void {
  tabDefaults = { ...d };
  if (opts.existing === false) return;
  usePanes.setState((s) => {
    const mapPane = (p: PaneState): PaneState => ({
      ...p,
      tabs: p.tabs.map((t) => ({
        ...t,
        sortKey: d.sortKey,
        sortOrder: defaultOrderFor(d.sortKey),
        viewMode: d.viewMode,
        showHidden: d.showHidden,
        cursorIndex: 0,
      })),
    });
    return {
      panes: { left: mapPane(s.panes.left), right: mapPane(s.panes.right) },
    };
  });
}
