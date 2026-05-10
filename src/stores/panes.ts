import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

export type PaneId = "left" | "right";
export type SortKey = "name" | "size" | "mtime" | "kind" | "ext";
export type SortOrder = "asc" | "desc";

export interface PaneState {
  location: Location;
  entries: Entry[];
  /** 현재 커서 위치 (키보드 네비). -1이면 선택 없음 */
  cursorIndex: number;
  /** 다중 선택 (Space로 토글). cursor와 별개 */
  selected: Set<string>;
  /** 마지막 갱신 시각 (refetch 트리거 디버깅용) */
  loadedAt: number;
  sortKey: SortKey;
  sortOrder: SortOrder;
  showHidden: boolean;
  filter: string;
  filterFocused: boolean;
}

interface PanesState {
  panes: Record<PaneId, PaneState>;
  activePane: PaneId;
  setEntries: (id: PaneId, location: Location, entries: Entry[]) => void;
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
}

const home = (): Location => ({
  source: { kind: "local" },
  // 백엔드가 절대경로 받음. 초기는 OS home directory가 이상적이지만
  // 그건 백엔드 platform 모듈 도움이 필요. MVP-0은 "/" 또는 CWD로 시작.
  // TODO: MVP-7에서 설정에 last-visited-path 저장
  path: "/",
});

const initialPane = (): PaneState => ({
  location: home(),
  entries: [],
  cursorIndex: -1,
  selected: new Set(),
  loadedAt: 0,
  sortKey: "name",
  sortOrder: "asc",
  showHidden: false,
  filter: "",
  filterFocused: false,
});

export const usePanes = create<PanesState>((set) => ({
  panes: {
    left: initialPane(),
    right: initialPane(),
  },
  activePane: "left",
  setEntries: (id, location, entries) =>
    set((s) => {
      const prevPath = s.panes[id].location.path;
      const navigated = prevPath !== location.path;
      return {
        panes: {
          ...s.panes,
          [id]: {
            ...s.panes[id],
            location,
            entries,
            cursorIndex: entries.length > 0 ? 0 : -1,
            selected: new Set(),
            loadedAt: Date.now(),
            filter: navigated ? "" : s.panes[id].filter,
            filterFocused: navigated ? false : s.panes[id].filterFocused,
          },
        },
      };
    }),
  setActivePane: (id) => set({ activePane: id }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const visible = computeDisplayed(p);
      const next = Math.max(0, Math.min(visible.length - 1, p.cursorIndex + delta));
      return { panes: { ...s.panes, [id]: { ...p, cursorIndex: next } } };
    }),
  setCursor: (id, index) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], cursorIndex: index } },
    })),
  toggleSelected: (id, name) =>
    set((s) => {
      const p = s.panes[id];
      const next = new Set(p.selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { panes: { ...s.panes, [id]: { ...p, selected: next } } };
    }),
  clearSelection: (id) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], selected: new Set() } },
    })),
  setSort: (id, key, order) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: { ...s.panes[id], sortKey: key, sortOrder: order, cursorIndex: 0 },
      },
    })),
  toggleSortKey: (id, key) =>
    set((s) => {
      const p = s.panes[id];
      if (p.sortKey === key) {
        return {
          panes: {
            ...s.panes,
            [id]: { ...p, sortOrder: p.sortOrder === "asc" ? "desc" : "asc" },
          },
        };
      }
      return {
        panes: { ...s.panes, [id]: { ...p, sortKey: key, sortOrder: "asc", cursorIndex: 0 } },
      };
    }),
  toggleShowHidden: (id) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: { ...s.panes[id], showHidden: !s.panes[id].showHidden, cursorIndex: 0 },
      },
    })),
  setFilter: (id, filter) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], filter, cursorIndex: 0 } },
    })),
  setFilterFocused: (id, focused) =>
    set((s) => ({
      panes: { ...s.panes, [id]: { ...s.panes[id], filterFocused: focused } },
    })),
}));

/** 표시 entries 계산 — raw → filter → hidden → sort. */
export function selectDisplayedEntries(id: PaneId, state: PanesState): Entry[] {
  return computeDisplayed(state.panes[id]);
}

function computeDisplayed(p: PaneState): Entry[] {
  let arr = p.entries;
  if (p.filter.length > 0) {
    const q = p.filter.toLowerCase();
    arr = arr.filter((e) => e.name.toLowerCase().includes(q));
  }
  if (!p.showHidden) {
    arr = arr.filter((e) => !e.hidden);
  }
  return sortEntries(arr, p.sortKey, p.sortOrder);
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
