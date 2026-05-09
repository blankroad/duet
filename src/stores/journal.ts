import { create } from "zustand";
import type { JournalEntry } from "@/types/bindings";

interface State {
  entries: JournalEntry[]; // tail, 최신이 마지막
  hasUndoable: boolean;
  pushed: (e: JournalEntry) => void;
  markUndone: (id: string) => void;
  setHistory: (es: JournalEntry[]) => void;
}

const computeUndoable = (entries: JournalEntry[]) =>
  entries.some((e) => !e.undone);

export const useJournal = create<State>((set) => ({
  entries: [],
  hasUndoable: false,
  pushed: (e) =>
    set((s) => {
      const entries = [...s.entries, e];
      return { entries, hasUndoable: computeUndoable(entries) };
    }),
  markUndone: (id) =>
    set((s) => {
      const entries = s.entries.map((e) =>
        e.id === id ? { ...e, undone: true } : e,
      );
      return { entries, hasUndoable: computeUndoable(entries) };
    }),
  setHistory: (es) =>
    set({ entries: es, hasUndoable: computeUndoable(es) }),
}));
