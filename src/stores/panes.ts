import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";
import { normalizePath } from "@/lib/entryDnd";
import { patternToMatcher } from "@/lib/glob";

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
  filter: string;
  filterFocused: boolean;
  /** "크기 계산"으로 구한 폴더 재귀 크기(name → bytes). 다른 폴더로 이동 시 리셋. */
  dirSizes: Record<string, number>;
  history: { stack: Location[]; index: number };
  /** 아카이브 내부 탐색 중이면 set, 아니면 undefined. */
  archive?: ArchiveBrowse | undefined;
  /** 휴지통 탐색 중이면 휴지통 루트 경로 — "Put back" 노출 + 떠나면 해제. */
  trashRoot?: string | undefined;
}

export interface PaneState {
  tabs: TabState[];
  activeTabIndex: number;
}

interface PanesState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  // tab management
  openTab: (id: PaneId, location?: Location) => void;
  closeTab: (id: PaneId, index: number) => void;
  selectTab: (id: PaneId, index: number) => void;
  // existing — 활성 탭에 dispatch
  setEntries: (
    id: PaneId,
    location: Location,
    entries: Entry[],
    opts?: { pushHistory?: boolean },
  ) => void;
  setActivePane: (id: PaneId) => void;
  moveCursor: (id: PaneId, delta: number) => void;
  setCursor: (id: PaneId, index: number) => void;
  toggleSelected: (id: PaneId, name: string) => void;
  /** 선택 집합을 names 로 교체 (마키 드래그 선택용). */
  setSelected: (id: PaneId, names: string[]) => void;
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
  setFilter: (id: PaneId, filter: string) => void;
  setFilterFocused: (id: PaneId, focused: boolean) => void;
  /** 아카이브 브라우즈 컨텍스트 설정/해제 (진입 시 set, null=해제). */
  setArchiveContext: (id: PaneId, ctx: ArchiveBrowse | null) => void;
  /** 휴지통 루트 설정/해제 (휴지통 이동 시 set). */
  setTrashRoot: (id: PaneId, root: string | null) => void;
  /** "크기 계산" 결과 기록 — 크기 컬럼에 폴더 재귀 크기 표시. 계산이 비동기라
   *  도착 시점에 탭이 바뀌었을 수 있어 tabId 로 대상 탭을 지정(없어졌으면 무시). */
  setDirSize: (id: PaneId, tabId: string, name: string, bytes: number) => void;
  // NEW
  back: (id: PaneId) => Location | null;
  forward: (id: PaneId) => Location | null;
  /** 좌/우 패널 내용 통째 교환 (포커스 위치는 유지). */
  swapPanes: () => void;
  /** 활성 패널의 현재 탭을 반대 패널로 이동(포커스도 따라감). */
  moveActiveTabToOther: () => void;
  /** 세션 복원 — 저장된 탭 레이아웃(로컬 탭)을 통째로 설정. 부팅 시 1회. */
  restoreLayout: (layout: RestoredLayout) => void;
}

/** 세션 영속용 슬림 레이아웃 — 로컬 탭만 (SSH 는 재시작 시 연결 소실). */
export interface RestoredLayout {
  activePane: PaneId;
  panes: Record<
    PaneId,
    {
      activeTabIndex: number;
      tabs: Array<{
        path: string;
        sortKey: SortKey;
        sortOrder: SortOrder;
        showHidden: boolean;
        viewMode: ViewMode;
      }>;
    }
  >;
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
    sortKey: "name",
    viewMode: "details",
    showHidden: false,
  };

const initialTab = (location: Location = home()): TabState => ({
  id: newTabId(),
  location,
  entries: [],
  cursorIndex: -1,
  selected: new Set(),
  loadedAt: 0,
  sortKey: tabDefaults.sortKey,
  sortOrder: "asc",
  showHidden: tabDefaults.showHidden,
  viewMode: tabDefaults.viewMode,
  gridCols: 1,
  filter: "",
  filterFocused: false,
  dirSizes: {},
  history: { stack: [location], index: 0 },
});

const initialPane = (): PaneState => ({
  tabs: [initialTab()],
  activeTabIndex: 0,
});

/** active tab 반환 — 외부 helper. */
export function activeTab(state: PanesState, id: PaneId): TabState {
  const p = state.panes[id];
  return p.tabs[p.activeTabIndex] ?? p.tabs[0]!;
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
  openTab: (id, location) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex] ?? p.tabs[0]!;
      const loc = location ?? cur.location;
      const nt = initialTab(loc);
      const tabs = [...p.tabs, nt];
      return {
        panes: { ...s.panes, [id]: { tabs, activeTabIndex: tabs.length - 1 } },
      };
    }),
  closeTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      if (p.tabs.length <= 1) return s;
      const tabs = p.tabs.slice();
      tabs.splice(index, 1);
      let next = p.activeTabIndex;
      if (index === p.activeTabIndex) {
        next = Math.max(0, index - 1);
      } else if (index < p.activeTabIndex) {
        next = p.activeTabIndex - 1;
      }
      return { panes: { ...s.panes, [id]: { tabs, activeTabIndex: next } } };
    }),
  selectTab: (id, index) =>
    set((s) => {
      const p = s.panes[id];
      if (index < 0 || index >= p.tabs.length) return s;
      return { panes: { ...s.panes, [id]: { ...p, activeTabIndex: index } } };
    }),
  setEntries: (id, location, entries, opts) =>
    set((s) => {
      // 저장 전 경로 정규화 — C:\/ 등 혼합/중복 구분자를 네이티브로(표시·영속 일관).
      const loc: Location = { ...location, path: normalizePath(location.path) };
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex];
      if (!cur) return s;
      const navigated = cur.location.path !== loc.path;
      const pushHistory = opts?.pushHistory ?? true;
      let history = cur.history;
      if (navigated && pushHistory) {
        const stack = history.stack.slice(0, history.index + 1);
        stack.push(loc);
        const trimmed =
          stack.length > 100 ? stack.slice(stack.length - 100) : stack;
        history = { stack: trimmed, index: trimmed.length - 1 };
      }
      // 아카이브/휴지통 루트 밖으로 이동하면 컨텍스트 해제 (내부 하위폴더면 유지).
      const archive =
        cur.archive && loc.path.startsWith(cur.archive.root)
          ? cur.archive
          : undefined;
      const trashRoot =
        cur.trashRoot && loc.path.startsWith(cur.trashRoot)
          ? cur.trashRoot
          : undefined;
      const nextTab: TabState = {
        ...cur,
        location: loc,
        entries,
        cursorIndex: entries.length > 0 ? 0 : -1,
        selected: new Set(),
        loadedAt: Date.now(),
        filter: navigated ? "" : cur.filter,
        filterFocused: navigated ? false : cur.filterFocused,
        // 같은 폴더 새로고침이면 계산해둔 폴더 크기 유지(약간 낡을 수 있음 — TC 동일).
        dirSizes: navigated ? {} : cur.dirSizes,
        history,
        archive,
        trashRoot,
      };
      return { panes: { ...s.panes, [id]: withActiveTab(p, () => nextTab) } };
    }),
  setActivePane: (id) => set({ activePane: id }),
  restoreLayout: (layout) =>
    set(() => {
      const buildPane = (slim: RestoredLayout["panes"][PaneId]): PaneState => {
        const tabs: TabState[] = slim.tabs.map((t) => ({
          ...initialTab({
            source: { kind: "local" },
            path: normalizePath(t.path),
          }),
          sortKey: t.sortKey,
          sortOrder: t.sortOrder,
          showHidden: t.showHidden,
          viewMode: t.viewMode,
        }));
        if (tabs.length === 0) return initialPane();
        const activeTabIndex = Math.min(
          Math.max(0, slim.activeTabIndex),
          tabs.length - 1,
        );
        return { tabs, activeTabIndex };
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
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          sortKey: key,
          sortOrder: order,
          cursorIndex: 0,
        })),
      },
    })),
  toggleSortKey: (id, key) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => {
          if (t.sortKey === key) {
            return { ...t, sortOrder: t.sortOrder === "asc" ? "desc" : "asc" };
          }
          return { ...t, sortKey: key, sortOrder: "asc", cursorIndex: 0 };
        }),
      },
    })),
  toggleShowHidden: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          showHidden: !t.showHidden,
          cursorIndex: 0,
        })),
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
  setFilter: (id, filter) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          filter,
          cursorIndex: 0,
        })),
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
  setArchiveContext: (id, ctx) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          archive: ctx ?? undefined,
        })),
      },
    })),
  setDirSize: (id, tabId, name, bytes) =>
    set((s) => {
      const p = s.panes[id];
      const i = p.tabs.findIndex((t) => t.id === tabId);
      const cur = p.tabs[i];
      if (!cur) return s;
      const tabs = p.tabs.slice();
      tabs[i] = { ...cur, dirSizes: { ...cur.dirSizes, [name]: bytes } };
      return { panes: { ...s.panes, [id]: { ...p, tabs } } };
    }),
  setTrashRoot: (id, root) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          trashRoot: root ?? undefined,
        })),
      },
    })),
  back: (id) => {
    const p = get().panes[id];
    const cur = p.tabs[p.activeTabIndex];
    if (!cur || cur.history.index <= 0) return null;
    const newIndex = cur.history.index - 1;
    const loc = cur.history.stack[newIndex]!;
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          history: { ...t.history, index: newIndex },
        })),
      },
    }));
    return loc;
  },
  forward: (id) => {
    const p = get().panes[id];
    const cur = p.tabs[p.activeTabIndex];
    if (!cur || cur.history.index >= cur.history.stack.length - 1) return null;
    const newIndex = cur.history.index + 1;
    const loc = cur.history.stack[newIndex]!;
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({
          ...t,
          history: { ...t.history, index: newIndex },
        })),
      },
    }));
    return loc;
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
      const dstTabs = [...dst.tabs, tab];
      return {
        panes: {
          ...s.panes,
          [from]: { tabs: srcTabs, activeTabIndex: srcActive },
          [to]: { tabs: dstTabs, activeTabIndex: dstTabs.length - 1 },
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
 * - Unix/SSH 루트: `/`
 * - Windows 드라이브 루트: `C:\`, `C:/`, `C:` (드라이브문자 + `:` + 선택적 구분자)
 */
export function isRootPath(p: string): boolean {
  if (p.length === 0 || p === "/") return true;
  return /^[A-Za-z]:[\\/]?$/.test(p);
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
  const sorted = sortEntries(arr, t.sortKey, t.sortOrder);
  // 루트가 아니고 필터가 없을 때만 최상단에 ".." (부모/아카이브 나가기) 행.
  // 정렬과 무관하게 항상 맨 위 고정. 빈 폴더에서도 돌아갈 수 있게 표시.
  // (아카이브/휴지통 임시 루트는 드라이브 루트가 아니라 isRootPath=false → ".." 유지.)
  if (!isRootPath(t.location.path) && t.filter.length === 0) {
    return [PARENT_ENTRY, ...sorted];
  }
  return sorted;
}

function sortEntries(
  entries: Entry[],
  key: SortKey,
  order: SortOrder,
): Entry[] {
  const dirsFirst = (a: Entry, b: Entry) => {
    if (a.kind !== b.kind) {
      if (a.kind === "dir") return -1;
      if (b.kind === "dir") return 1;
    }
    return 0;
  };
  const cmpName = (a: Entry, b: Entry) => a.name.localeCompare(b.name);
  const cmpExt = (a: Entry, b: Entry) => {
    const ax = a.name.lastIndexOf(".");
    const bx = b.name.lastIndexOf(".");
    const ae = ax >= 0 ? a.name.slice(ax + 1) : "";
    const be = bx >= 0 ? b.name.slice(bx + 1) : "";
    return ae.localeCompare(be) || cmpName(a, b);
  };
  const cmpKey = (a: Entry, b: Entry): number => {
    switch (key) {
      case "name":
        return cmpName(a, b);
      case "size":
        return (a.size ?? 0) - (b.size ?? 0) || cmpName(a, b);
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
 * 설정에서 새 탭 기본값을 주입 + 현재 열린 모든 탭에도 적용 (부팅 시 1회 / 설정 변경 시).
 * 새 탭은 tabDefaults 를 통해, 기존 탭은 즉시 갱신 — "default view" 등이 바로 반영되게.
 */
export function applyTabDefaults(d: {
  sortKey: SortKey;
  viewMode: ViewMode;
  showHidden: boolean;
}): void {
  tabDefaults = { ...d };
  usePanes.setState((s) => {
    const mapPane = (p: PaneState): PaneState => ({
      ...p,
      tabs: p.tabs.map((t) => ({
        ...t,
        sortKey: d.sortKey,
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
