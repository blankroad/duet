import { create } from "zustand";

/**
 * UI 상태 (모달 표시, 사이드바 토글 등).
 * 패널 데이터(content)는 panes 스토어에 분리.
 */
interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  /** 미리보기 패널 표시 여부 (F11 토글). */
  previewOpen: boolean;
  togglePreview: () => void;
}

export const useUI = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  previewOpen: false,
  togglePreview: () => set((s) => ({ previewOpen: !s.previewOpen })),
}));
