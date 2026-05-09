import { create } from "zustand";

interface State {
  message: string | null;
  show: (msg: string) => void;
  clear: () => void;
}

export const useToast = create<State>((set) => ({
  message: null,
  show: (msg) => {
    set({ message: msg });
    setTimeout(() => {
      set((s) => (s.message === msg ? { message: null } : s));
    }, 3000);
  },
  clear: () => set({ message: null }),
}));
