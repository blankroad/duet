import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { Bookmark, Location } from "@/types/bindings";

interface State {
  items: Bookmark[];
  setAll: (items: Bookmark[]) => void;
}

export const useBookmarks = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapBookmarks(): Promise<void> {
  const r = await commands.bookmarksList();
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
}

export async function addBookmark(
  name: string,
  location: Location,
): Promise<boolean> {
  const r = await commands.bookmarksAdd(name, location);
  if (r.status === "ok") {
    useBookmarks.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function removeBookmark(id: string): Promise<void> {
  const r = await commands.bookmarksRemove(id);
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
}
