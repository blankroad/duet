import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";

export type PaneId = "left" | "right";

export interface PaneState {
  location: Location;
  entries: Entry[];
  /** 현재 커서 위치 (키보드 네비). -1이면 선택 없음 */
  cursorIndex: number;
  /** 다중 선택 (Space로 토글). cursor와 별개 */
  selected: Set<string>;
  /** 마지막 갱신 시각 (refetch 트리거 디버깅용) */
  loadedAt: number;
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
}

const home = (): Location => ({
  source: { kind: "local" },
  // 백엔드가 절대경로 받음. 초기는 OS home directory가 이상적이지만
  // 그건 백엔드 platform 모듈 도움이 필요. MVP-0은 "/" 또는 CWD로 시작.
  // TODO: MVP-7에서 설정에 last-visited-path 저장
  path: "/",
});

export const usePanes = create<PanesState>((set) => ({
  panes: {
    left: { location: home(), entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
    right: { location: home(), entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
  },
  activePane: "left",
  setEntries: (id, location, entries) =>
    set((s) => ({
      panes: {
        ...s.panes,
        [id]: {
          ...s.panes[id],
          location,
          entries,
          cursorIndex: entries.length > 0 ? 0 : -1,
          selected: new Set(),
          loadedAt: Date.now(),
        },
      },
    })),
  setActivePane: (id) => set({ activePane: id }),
  moveCursor: (id, delta) =>
    set((s) => {
      const p = s.panes[id];
      const next = Math.max(0, Math.min(p.entries.length - 1, p.cursorIndex + delta));
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
}));
