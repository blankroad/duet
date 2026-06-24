import { create } from "zustand";

/** frecency 점퍼(Ctrl+J) 열림 상태 — CommandPalette 와 동일한 단순 모달 토글. */
interface State {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useFrecency = create<State>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
