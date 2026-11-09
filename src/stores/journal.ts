import { create } from "zustand";
import type { JournalEntry } from "@/types/bindings";

interface State {
  entries: JournalEntry[]; // tail, 최신이 마지막
  hasUndoable: boolean;
  /** stale 을 건너뛴 마지막 entry 가 undone 이면 redo 가능 (백엔드와 동일). */
  hasRedoable: boolean;
  pushed: (e: JournalEntry) => void;
  markUndone: (id: string) => void;
  markRedone: (id: string) => void;
  markStale: (id: string) => void;
  setHistory: (es: JournalEntry[]) => void;
}

const computeUndoable = (entries: JournalEntry[]) =>
  entries.some((e) => !e.undone && !e.stale);
const computeRedoable = (entries: JournalEntry[]) =>
  [...entries].reverse().find((e) => !e.stale)?.undone ?? false;

const derive = (entries: JournalEntry[]) => ({
  entries,
  hasUndoable: computeUndoable(entries),
  hasRedoable: computeRedoable(entries),
});

export const useJournal = create<State>((set) => ({
  entries: [],
  hasUndoable: false,
  hasRedoable: false,
  pushed: (e) => set((s) => derive([...s.entries, e])),
  markUndone: (id) =>
    set((s) =>
      derive(s.entries.map((e) => (e.id === id ? { ...e, undone: true } : e))),
    ),
  markRedone: (id) =>
    set((s) =>
      derive(s.entries.map((e) => (e.id === id ? { ...e, undone: false } : e))),
    ),
  markStale: (id) =>
    set((s) =>
      derive(s.entries.map((e) => (e.id === id ? { ...e, stale: true } : e))),
    ),
  setHistory: (es) => set(derive(es)),
}));
