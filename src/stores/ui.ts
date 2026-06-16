import { create } from "zustand";
import type { PaneId } from "@/stores/panes";

/**
 * UI 상태 (모달 표시, 사이드바 토글 등).
 * 패널 데이터(content)는 panes 스토어에 분리.
 */

const COLLAPSE_KEY = "duet.sidebar.collapsed";

/** 사이드바 섹션 접힘 상태 localStorage 로드 (비민감 UI 설정). */
function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveCollapsed(c: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(c));
  } catch {
    /* localStorage 불가 환경 — 메모리 상태만 유지 */
  }
}

interface UIState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  /** 미리보기 패널 표시 여부 (F11 토글). */
  previewOpen: boolean;
  togglePreview: () => void;
  /** Quick Look 대형 오버레이 표시 여부 (Space 토글, 파인더 관례). */
  quickLookOpen: boolean;
  toggleQuickLook: () => void;
  closeQuickLook: () => void;
  /** 사이드바 섹션/그룹 접힘 상태 (key → collapsed). 영속. */
  collapsed: Record<string, boolean>;
  toggleSection: (key: string) => void;
  /** "경로 직접 입력" 요청 — Ctrl+L 등에서 활성 패널 PathBar 를 편집 모드로.
   *  nonce 가 증가하면 editPathPane 패널의 PathBar 가 편집 진입. */
  editPathPane: PaneId | null;
  editPathNonce: number;
  requestEditPath: (pane: PaneId) => void;
}

export const useUI = create<UIState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  previewOpen: true,
  togglePreview: () => set((s) => ({ previewOpen: !s.previewOpen })),
  quickLookOpen: false,
  toggleQuickLook: () => set((s) => ({ quickLookOpen: !s.quickLookOpen })),
  closeQuickLook: () => set({ quickLookOpen: false }),
  collapsed: loadCollapsed(),
  toggleSection: (key) =>
    set((s) => {
      const collapsed = { ...s.collapsed, [key]: !s.collapsed[key] };
      saveCollapsed(collapsed);
      return { collapsed };
    }),
  editPathPane: null,
  editPathNonce: 0,
  requestEditPath: (pane) =>
    set((s) => ({ editPathPane: pane, editPathNonce: s.editPathNonce + 1 })),
}));
