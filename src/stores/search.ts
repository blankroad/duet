import { create } from "zustand";
import type { Location, SearchHit } from "@/types/bindings";
import type { PaneId } from "./panes";

export type SearchStatus = "idle" | "searching" | "done" | "error" | "cancelled";

interface SearchState {
  isOpen: boolean;
  rootPaneId: PaneId | null;
  root: Location | null;
  query: string;
  results: SearchHit[];
  status: SearchStatus;
  error: string | null;

  open: (paneId: PaneId, root: Location) => void;
  close: () => void;
  /** input 의 onChange 직접 호출 — 실제 IPC 발사는 SearchPanel 컴포넌트가 debounce. */
  setQueryNow: (q: string) => void;
  setResults: (hits: SearchHit[]) => void;
  setStatus: (s: SearchStatus) => void;
  setError: (msg: string) => void;
}

export const useSearch = create<SearchState>((set) => ({
  isOpen: false,
  rootPaneId: null,
  root: null,
  query: "",
  results: [],
  status: "idle",
  error: null,

  open: (paneId, root) =>
    set({ isOpen: true, rootPaneId: paneId, root, query: "", results: [], status: "idle", error: null }),
  close: () =>
    set({ isOpen: false, rootPaneId: null, root: null, query: "", results: [], status: "idle", error: null }),
  setQueryNow: (q) => set({ query: q }),
  setResults: (hits) => set({ results: hits, status: "done", error: null }),
  setStatus: (s) => set({ status: s }),
  setError: (msg) => set({ error: msg, status: "error" }),
}));
