import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

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
  history: { stack: Location[]; index: number };
  /** 아카이브 내부 탐색 중이면 set, 아니면 undefined. */
  archive?: ArchiveBrowse | undefined;
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
  setEntries: (id: PaneId, location: Location, entries: Entry[], opts?: { pushHistory?: boolean }) => void;
  setActivePane: (id: PaneId) => void;
  moveCursor: (id: PaneId, delta: number) => void;
  setCursor: (id: PaneId, index: number) => void;
  toggleSelected: (id: PaneId, name: string) => void;
  /** 선택 집합을 names 로 교체 (마키 드래그 선택용). */
  setSelected: (id: PaneId, names: string[]) => void;
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
  // NEW
  back: (id: PaneId) => Location | null;
  forward: (id: PaneId) => Location | null;
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

const initialTab = (location: Location = home()): TabState => ({
  id: newTabId(),
  location,
  entries: [],
  cursorIndex: -1,
  selected: new Set(),
  loadedAt: 0,
  sortKey: "name",
  sortOrder: "asc",
  showHidden: false,
  viewMode: "details",
  gridCols: 1,
  filter: "",
  filterFocused: false,
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
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex];
      if (!cur) return s;
      const navigated = cur.location.path !== location.path;
      const pushHistory = opts?.pushHistory ?? true;
      let history = cur.history;
      if (navigated && pushHistory) {
        const stack = history.stack.slice(0, history.index + 1);
        stack.push(location);
        const trimmed = stack.length > 100 ? stack.slice(stack.length - 100) : stack;
        history = { stack: trimmed, index: trimmed.length - 1 };
      }
      // 아카이브 임시 루트 밖으로 이동하면 컨텍스트 해제 (내부 하위폴더면 유지).
      const archive =
        cur.archive && location.path.startsWith(cur.archive.root) ? cur.archive : undefined;
      const nextTab: TabState = {
        ...cur,
        location,
        entries,
        cursorIndex: entries.length > 0 ? 0 : -1,
        selected: new Set(),
        loadedAt: Date.now(),
        filter: navigated ? "" : cur.filter,
        filterFocused: navigated ? false : cur.filterFocused,
        history,
        archive,
      };
      return { panes: { ...s.panes, [id]: withActiveTab(p, () => nextTab) } };
    }),
  setActivePane: (id) => set({ activePane: id }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const cur = p.tabs[p.activeTabIndex];
      if (!cur) return s;
      const visible = computeDisplayed(cur);
      const next = Math.max(0, Math.min(visible.length - 1, cur.cursorIndex + delta));
      return { panes: { ...s.panes, [id]: withActiveTab(p, (t) => ({ ...t, cursorIndex: next })) } };
    }),
  setCursor: (id, index) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, cursorIndex: index })) },
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
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, selected: new Set(names) })),
      },
    })),
  clearSelection: (id) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, selected: new Set() })) },
    })),
  setSort: (id, key, order) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, sortKey: key, sortOrder: order, cursorIndex: 0 })),
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
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, showHidden: !t.showHidden, cursorIndex: 0 })),
      },
    })),
  setViewMode: (id, mode) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => (t.viewMode === mode ? t : { ...t, viewMode: mode })),
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
          [id]: withActiveTab(s.panes[id], (t) => (t.gridCols === c ? t : { ...t, gridCols: c })),
        },
      };
    }),
  setFilter: (id, filter) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, filter, cursorIndex: 0 })) },
    })),
  setFilterFocused: (id, focused) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, filterFocused: focused })) },
    })),
  setArchiveContext: (id, ctx) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: withActiveTab(s.panes[id], (t) => ({ ...t, archive: ctx ?? undefined })),
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
  if (t.location.path !== "/" && t.location.path.length > 0 && t.filter.length === 0) {
    return [PARENT_ENTRY, ...sorted];
  }
  return sorted;
}

function sortEntries(entries: Entry[], key: SortKey, order: SortOrder): Entry[] {
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
