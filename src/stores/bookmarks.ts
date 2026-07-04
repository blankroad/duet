import { create } from "zustand";
import { commands } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import type { Bookmark, Location } from "@/types/bindings";
import { useHostFavorites, addHostFavorite } from "@/stores/hostFavorites";
import { useToast } from "@/stores/toast";

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
  if (r.status !== "ok") return;
  useBookmarks.getState().setAll(r.data);
  await migrateSshBookmarks(r.data);
}

/**
 * 레거시 SSH 북마크(ephemeral connection_id 박힘 — 재접속 시 깨짐)를 호스트
 * 즐겨찾기로 1회 이전. connection_id `"{alias}:{uuid}"` 에서 alias 추출.
 * 멱등: 같은 (alias, path) 즐겨찾기가 이미 있으면 건너뜀.
 */
async function migrateSshBookmarks(items: Bookmark[]): Promise<void> {
  const sshBms = items.filter((b) => b.location.source.kind === "ssh");
  if (sshBms.length === 0) return;
  let moved = 0;
  for (const b of sshBms) {
    if (b.location.source.kind !== "ssh") continue;
    const alias = b.location.source.connection_id.split(":")[0] ?? "";
    const path = String(b.location.path);
    if (!alias) continue;
    const exists = useHostFavorites
      .getState()
      .items.some((f) => f.host_alias === alias && String(f.path) === path);
    if (!exists) await addHostFavorite(alias, b.name, path);
    await removeBookmark(b.id);
    moved += 1;
  }
  if (moved > 0) useToast.getState().show(`Moved ${moved} SSH bookmark(s) to host favorites`);
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
  else useToast.getState().show(`Remove bookmark: ${formatErr(r.error)}`, "error");
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
