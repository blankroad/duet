import { create } from "zustand";
import { reorderInSlots } from "@/lib/reorderSlots";
import { commands } from "@/types/bindings";
import { showError } from "@/lib/errorToast";
import { aliasFromConnectionId } from "@/lib/hostAlias";
import type { Bookmark, Location } from "@/types/bindings";
import { useHostFavorites, addHostFavorite } from "@/stores/hostFavorites";
import { useToast } from "@/stores/toast";
import i18n from "@/i18n";

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
  let failed = 0;
  for (const b of sshBms) {
    if (b.location.source.kind !== "ssh") continue;
    const alias = aliasFromConnectionId(b.location.source.connection_id);
    const path = String(b.location.path);
    if (!alias) continue;
    const exists = useHostFavorites
      .getState()
      .items.some((f) => f.host_alias === alias && String(f.path) === path);
    // 즐겨찾기 저장이 실패하면 원본 북마크를 지우지 않는다 — 다음 실행 때 다시 시도.
    if (!exists && !(await addHostFavorite(alias, b.name, path))) {
      failed += 1;
      continue;
    }
    await removeBookmark(b.id);
    moved += 1;
  }
  if (moved > 0)
    useToast
      .getState()
      .show(i18n.t("toast.bookmarksMigrated", { count: moved }));
  if (failed > 0)
    useToast
      .getState()
      .show(
        i18n.t("toast.bookmarksMigrateFailed", { count: failed }),
        "warning",
      );
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

/** 이름만 변경 — 위치·순서·태그는 그대로. */
export async function renameBookmark(id: string, name: string): Promise<void> {
  const r = await commands.bookmarksRename(id, name);
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
  else showError("toast.renameFailed", r.error);
}

export async function removeBookmark(id: string): Promise<void> {
  const r = await commands.bookmarksRemove(id);
  if (r.status === "ok") useBookmarks.getState().setAll(r.data);
  else showError("toast.removeBookmarkFailed", r.error);
}

/** 드래그 재정렬 — id 순서대로. 낙관적 갱신 후 백엔드 반환값으로 정합. */
export async function reorderBookmarks(ids: string[]): Promise<void> {
  const prev = useBookmarks.getState().items;
  // 필터로 일부만 보일 때도 나머지를 지우지 않게 — 자리 채우기(백엔드와 같은 규칙).
  const optimistic = reorderInSlots(prev, (b) => b.id, ids);
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
