import { create } from "zustand";
import type { PaneId } from "@/stores/panes";

/**
 * UI 상태 (모달 표시, 사이드바 토글 등).
 * 패널 데이터(content)는 panes 스토어에 분리.
 */

const COLLAPSE_KEY = "duet.sidebar.collapsed";
const SPLITEXT_KEY = "duet.view.splitExt";
const SYNCBROWSE_KEY = "duet.view.syncBrowse";

/** boolean UI 설정 localStorage 로드 (비민감). */
function loadBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function saveBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* localStorage 불가 — 메모리 상태만 */
  }
}

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
  /** 상세 뷰에서 확장자를 별도 컬럼으로 분리 표시 (TC 식). 영속. */
  splitExt: boolean;
  toggleSplitExt: () => void;
  /** 동기화 브라우징 — 활성 패널의 폴더 진입/위로에 반대 패널 동행(존재 시). 영속. */
  syncBrowse: boolean;
  toggleSyncBrowse: () => void;
  /** "경로 직접 입력" 요청 — Ctrl+L 등에서 활성 패널 PathBar 를 편집 모드로.
   *  nonce 가 증가하면 editPathPane 패널의 PathBar 가 편집 진입. */
  editPathPane: PaneId | null;
  editPathNonce: number;
  requestEditPath: (pane: PaneId) => void;
  /** "패턴 선택" 요청 — Ctrl+= / Ctrl+- 에서 활성 패널의 SelectPatternBar 오픈.
   *  nonce 증가 시 selectPatternPane 패널의 바가 selectPatternMode 로 열린다. */
  selectPatternPane: PaneId | null;
  selectPatternMode: "add" | "remove";
  selectPatternNonce: number;
  requestSelectPattern: (pane: PaneId, mode: "add" | "remove") => void;
  /** 인라인 이름변경(F2) 대상 — 해당 pane 의 행/셀이 편집 input 으로 전환. */
  renameTarget: { pane: PaneId; name: string } | null;
  requestInlineRename: (pane: PaneId, name: string) => void;
  clearInlineRename: () => void;
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
  splitExt: loadBool(SPLITEXT_KEY),
  toggleSplitExt: () =>
    set((s) => {
      const splitExt = !s.splitExt;
      saveBool(SPLITEXT_KEY, splitExt);
      return { splitExt };
    }),
  syncBrowse: loadBool(SYNCBROWSE_KEY),
  toggleSyncBrowse: () =>
    set((s) => {
      const syncBrowse = !s.syncBrowse;
      saveBool(SYNCBROWSE_KEY, syncBrowse);
      return { syncBrowse };
    }),
  editPathPane: null,
  editPathNonce: 0,
  requestEditPath: (pane) =>
    set((s) => ({ editPathPane: pane, editPathNonce: s.editPathNonce + 1 })),
  selectPatternPane: null,
  selectPatternMode: "add",
  selectPatternNonce: 0,
  requestSelectPattern: (pane, mode) =>
    set((s) => ({
      selectPatternPane: pane,
      selectPatternMode: mode,
      selectPatternNonce: s.selectPatternNonce + 1,
    })),
  renameTarget: null,
  requestInlineRename: (pane, name) => set({ renameTarget: { pane, name } }),
  clearInlineRename: () => set({ renameTarget: null }),
}));
