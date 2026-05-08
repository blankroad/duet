import { create } from "zustand";

/**
 * UI 상태 (모달 표시, 사이드바 토글 등).
 * 패널 데이터(content)는 panes 스토어에 분리.
 */
interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useUI = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));
