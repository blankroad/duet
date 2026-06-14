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

/** 드래그 재정렬 — id 순서대로. 낙관적 갱신 후 백엔드 반환값으로 정합. */
export async function reorderBookmarks(ids: string[]): Promise<void> {
  const prev = useBookmarks.getState().items;
  const byId = new Map(prev.map((b) => [b.id, b]));
  const optimistic = ids.map((id) => byId.get(id)).filter((b): b is Bookmark => b !== undefined);
  useBookmarks.getState().setAll(optimistic);
  const r = await commands.bookmarksReorder(ids);
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
  else useBookmarks.getState().setAll(prev);
}

/** location 이 북마크돼 있으면 그 id, 아니면 null. */
export function findBookmarkId(location: Location): string | null {
  const items = useBookmarks.getState().items;
  const hit = items.find((b) => sameBookmarkLocation(b.location, location));
  return hit?.id ?? null;
}

export function sameBookmarkLocation(a: Location, b: Location): boolean {
  if (a.source.kind !== b.source.kind) return false;
  if (a.source.kind === "ssh" && b.source.kind === "ssh") {
    if (a.source.connection_id !== b.source.connection_id) return false;
  }
  return String(a.path) === String(b.path);
}
