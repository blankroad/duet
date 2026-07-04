import { create } from "zustand";
import type { JournalEntry } from "@/types/bindings";

interface State {
  entries: JournalEntry[]; // tail, 최신이 마지막
  hasUndoable: boolean;
  /** 마지막 entry 가 undone 이면 redo 가능 (LIFO — 백엔드 peek_redoable 과 동일 규칙). */
  hasRedoable: boolean;
  pushed: (e: JournalEntry) => void;
  markUndone: (id: string) => void;
  markRedone: (id: string) => void;
  setHistory: (es: JournalEntry[]) => void;
}

const computeUndoable = (entries: JournalEntry[]) =>
  entries.some((e) => !e.undone);
const computeRedoable = (entries: JournalEntry[]) =>
  entries.length > 0 && entries[entries.length - 1]!.undone;

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
  setHistory: (es) => set(derive(es)),
}));
