import { create } from "zustand";
import type { PaneId } from "@/stores/panes";

/**
 * UI 상태 (모달 표시, 사이드바 토글 등).
 * 패널 데이터(content)는 panes 스토어에 분리.
 */

const COLLAPSE_KEY = "duet.sidebar.collapsed";
const SPLITEXT_KEY = "duet.view.splitExt";
const SYNCBROWSE_KEY = "duet.view.syncBrowse";
const DENSITY_KEY = "duet.view.density";
const SINGLEPANE_KEY = "duet.view.singlePane";

/** 목록 밀도 — 행 높이/셀 크기만 바뀌고 폰트는 유지 (TC 식 compact). */
export type Density = "normal" | "compact";

/** 밀도별 픽셀 메트릭 — 가상 스크롤 estimateSize/마키 hitTest 와 CSS 가 공유. */
export function densityMetrics(d: Density): {
  row: number;
  tile: number;
  gridCell: number;
} {
  // gridCell 하한: 썸네일 48 + 이름 1줄 + 패딩 ≈ 84px — 더 줄이면 잘림.
  return d === "compact"
    ? { row: 22, tile: 40, gridCell: 84 }
    : { row: 28, tile: 48, gridCell: 92 };
}

function loadDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact"
      ? "compact"
      : "normal";
  } catch {
    return "normal";
  }
}

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
  /** 목록 밀도 (행 높이). 비민감 UI 설정 — localStorage 영속. */
  density: Density;
  setDensity: (d: Density) => void;
  /**
   * 단일 패널 모드 — 활성 패널만 전체 폭으로 표시 (Opus F6/TC 100% 대응).
   * 숨긴 패널의 상태(탭/경로/선택)는 panes store 에 그대로 살아 있어
   * F5/F6(반대 패널로 복사/이동)이 계속 동작하고, Tab 은 "보이는 패널 교체"가 된다.
   */
  singlePane: boolean;
  toggleSinglePane: () => void;
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
  density: loadDensity(),
  setDensity: (d) => {
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* localStorage 불가 — 메모리 상태만 */
    }
    set({ density: d });
  },
  singlePane: loadBool(SINGLEPANE_KEY),
  toggleSinglePane: () =>
    set((s) => {
      const singlePane = !s.singlePane;
      saveBool(SINGLEPANE_KEY, singlePane);
      return { singlePane };
    }),
}));
