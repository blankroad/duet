import { create } from "zustand";

const RECENT_KEY = "duet.palette.recent";
const RECENT_MAX = 8;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

interface State {
  isOpen: boolean;
  /** 열 때 미리 채워 둘 검색어 (빠른 접속 등). */
  initialQuery: string;
  /** 최근 실행한 커맨드 id — 빈 검색어일 때 위로 올린다 (DESIGN "최근 사용 우선"). */
  recent: string[];
  open: (initialQuery?: string) => void;
  close: () => void;
  remember: (id: string) => void;
}

export const usePalette = create<State>((set) => ({
  isOpen: false,
  initialQuery: "",
  recent: loadRecent(),
  open: (initialQuery = "") => set({ isOpen: true, initialQuery }),
  close: () => set({ isOpen: false, initialQuery: "" }),
  remember: (id) =>
    set((s) => {
      const recent = [id, ...s.recent.filter((x) => x !== id)].slice(
        0,
        RECENT_MAX,
      );
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
      } catch {
        /* localStorage 불가 — 메모리 상태만 */
      }
      return { recent };
    }),
}));
