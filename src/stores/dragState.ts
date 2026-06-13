import { create } from "zustand";
import type { EntryRef, Location } from "@/types/bindings";
import type { PaneId } from "@/stores/panes";

/**
 * 인앱 포인터 기반 드래그의 전역 상태 — 드래그 고스트 오버레이와 드롭존 하이라이트가 구독.
 * HTML5 DnD 를 쓰지 않으므로 (Tauri dragDropEnabled 충돌 회피) 좌표/대상을 직접 관리.
 */
interface DragState {
  active: boolean;
  source: Location | null;
  targets: EntryRef[];
  label: string;
  /** 커서 위치 (viewport px) — 고스트 추적. */
  x: number;
  y: number;
  /** 현재 커서가 올라간 드롭 대상 패널 / 폴더명 (하이라이트용). */
  overPane: PaneId | null;
  overFolder: string | null;
  start: (p: { source: Location; targets: EntryRef[]; label: string; x: number; y: number }) => void;
  move: (x: number, y: number, overPane: PaneId | null, overFolder: string | null) => void;
  end: () => void;
}

export const useDragState = create<DragState>((set) => ({
  active: false,
  source: null,
  targets: [],
  label: "",
  x: 0,
  y: 0,
  overPane: null,
  overFolder: null,
  start: (p) => set({ ...p, active: true, overPane: null, overFolder: null }),
  move: (x, y, overPane, overFolder) => set({ x, y, overPane, overFolder }),
  end: () =>
    set({ active: false, source: null, targets: [], label: "", overPane: null, overFolder: null }),
}));
