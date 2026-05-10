import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

export type PaneId = "left" | "right";
export type SortKey = "name" | "size" | "mtime" | "kind" | "ext";
export type SortOrder = "asc" | "desc";

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
  filter: string;
  filterFocused: boolean;
  history: { stack: Location[]; index: number };
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
  clearSelection: (id: PaneId) => void;
  setSort: (id: PaneId, key: SortKey, order: SortOrder) => void;
  toggleSortKey: (id: PaneId, key: SortKey) => void;
  toggleShowHidden: (id: PaneId) => void;
  setFilter: (id: PaneId, filter: string) => void;
  setFilterFocused: (id: PaneId, focused: boolean) => void;
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
  setFilter: (id, filter) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, filter, cursorIndex: 0 })) },
    })),
  setFilterFocused: (id, focused) =>
    set((s) => ({
      panes: { ...s.panes, [id]: withActiveTab(s.panes[id], (t) => ({ ...t, filterFocused: focused })) },
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

function computeDisplayed(t: TabState): Entry[] {
  let arr = t.entries;
  if (t.filter.length > 0) {
    const q = t.filter.toLowerCase();
    arr = arr.filter((e) => e.name.toLowerCase().includes(q));
  }
  if (!t.showHidden) {
    arr = arr.filter((e) => !e.hidden);
  }
  return sortEntries(arr, t.sortKey, t.sortOrder);
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
