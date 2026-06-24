import { create } from "zustand";

/** 사이드바 태그 필터(OR) — 활성 태그가 있으면 Hosts/Bookmarks 를 해당 태그로 좁힘. */
interface State {
  active: string[];
  toggle: (tag: string) => void;
  clear: () => void;
}

export const useTagFilter = create<State>((set) => ({
  active: [],
  toggle: (tag) =>
    set((s) => ({
      active: s.active.includes(tag)
        ? s.active.filter((t) => t !== tag)
        : [...s.active, tag],
    })),
  clear: () => set({ active: [] }),
}));
