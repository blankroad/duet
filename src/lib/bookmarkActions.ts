import type { Location } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { addBookmark, findBookmarkId } from "@/stores/bookmarks";
import { addHostFavorite } from "@/stores/hostFavorites";
import { useToast } from "@/stores/toast";

/**
 * location 을 북마크 — SSH 면 호스트 즐겨찾기(host_alias+경로, 재접속에 안전)로,
 * 로컬이면 일반 북마크로. SSH 북마크에 ephemeral connection_id 가 박히는 걸 방지.
 */
export async function bookmarkLocation(location: Location, name: string): Promise<void> {
  if (location.source.kind === "ssh") {
    const connId = location.source.connection_id;
    const conn = Object.values(useConnections.getState().active).find((c) => c.id === connId);
    if (!conn) {
      useToast.getState().show("Active connection not found");
      return;
    }
    const ok = await addHostFavorite(conn.alias, name, String(location.path));
    useToast.getState().show(ok ? `Bookmarked on ${conn.alias}: ${name}` : "Bookmark failed");
    return;
  }
  if (findBookmarkId(location)) return;
  await addBookmark(name, location);
}
