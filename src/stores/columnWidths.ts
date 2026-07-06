import { create } from "zustand";

/**
 * 상세 뷰 컬럼 폭 — Ext/Size/Modified 는 사용자가 헤더 경계를 드래그해 조절, Name 은
 * 나머지 공간(flex). localStorage 영속(재시작 복원). 헤더·행이 CSS 변수(`--col-*`)를
 * 공유해 항상 정렬. (밀도/뷰처럼 비민감 UI 라 settings.toml 아닌 localStorage.)
 */
export type ColKey = "ext" | "size" | "mtime";

interface ColWidths {
  ext: number;
  size: number;
  mtime: number;
}

const KEY = "duet.columnWidths.v1";
const DEFAULTS: ColWidths = { ext: 64, size: 80, mtime: 88 };
const MIN = 40;
const MAX = 600;

function load(): ColWidths {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ColWidths>;
      return {
        ext: clamp(v.ext ?? DEFAULTS.ext),
        size: clamp(v.size ?? DEFAULTS.size),
        mtime: clamp(v.mtime ?? DEFAULTS.mtime),
      };
    }
  } catch {
    /* 손상/불가 → 기본값 */
  }
  return { ...DEFAULTS };
}

function clamp(px: number): number {
  return Math.max(MIN, Math.min(MAX, Math.round(px)));
}

interface State extends ColWidths {
  setWidth: (col: ColKey, px: number) => void;
}

export const useColumnWidths = create<State>((set, get) => ({
  ...load(),
  setWidth: (col, px) => {
    set({ [col]: clamp(px) } as Pick<ColWidths, ColKey>);
    try {
      const { ext, size, mtime } = get();
      localStorage.setItem(KEY, JSON.stringify({ ext, size, mtime }));
    } catch {
      /* localStorage 불가 — 메모리만 */
    }
  },
}));
