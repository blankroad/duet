import { create } from "zustand";

/**
 * 사이드바 폭 — 오른쪽 가장자리를 끌어 조절, 더블클릭으로 기본값. localStorage 영속.
 * (컬럼 폭과 같은 결의 비민감 UI 설정이라 settings.toml 이 아닌 localStorage.)
 *
 * 예전엔 `w-48`(192px) 하드코딩이라 `build-runner-01` 같은 호스트 이름이 잘렸다.
 */
const KEY = "duet.sidebarWidth.v1";
export const SIDEBAR_WIDTH_DEFAULT = 192;
const MIN = 150;
const MAX = 420;

export function clampSidebarWidth(px: number): number {
  return Math.max(MIN, Math.min(MAX, Math.round(px)));
}

function load(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return clampSidebarWidth(n);
    }
  } catch {
    /* 손상/불가 → 기본값 */
  }
  return SIDEBAR_WIDTH_DEFAULT;
}

interface State {
  width: number;
  setWidth: (px: number) => void;
  reset: () => void;
}

export const useSidebarWidth = create<State>((set) => {
  const commit = (px: number) => {
    const w = clampSidebarWidth(px);
    set({ width: w });
    try {
      localStorage.setItem(KEY, String(w));
    } catch {
      /* localStorage 불가 — 메모리만 */
    }
  };
  return {
    width: load(),
    setWidth: commit,
    reset: () => commit(SIDEBAR_WIDTH_DEFAULT),
  };
});
