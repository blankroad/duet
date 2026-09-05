import type { Location } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { addBookmark, findBookmarkId } from "@/stores/bookmarks";
import { addHostFavorite } from "@/stores/hostFavorites";
import { useToast } from "@/stores/toast";
import { useUI } from "@/stores/ui";
import i18n from "@/i18n";

/**
 * location 을 북마크 — SSH 면 호스트 즐겨찾기(host_alias+경로, 재접속에 안전)로,
 * 로컬이면 일반 북마크로. SSH 북마크에 ephemeral connection_id 가 박히는 걸 방지.
 */
export async function bookmarkLocation(
  location: Location,
  name: string,
): Promise<void> {
  if (location.source.kind === "ssh") {
    const connId = location.source.connection_id;
    const conn = Object.values(useConnections.getState().active).find(
      (c) => c.id === connId,
    );
    if (!conn) {
      useToast.getState().show(i18n.t("toast.noActiveConnection"), "error");
      return;
    }
    const ok = await addHostFavorite(conn.alias, name, String(location.path));
    useToast
      .getState()
      .show(
        ok
          ? i18n.t("toast.bookmarkedOnHost", { host: conn.alias, name })
          : i18n.t("toast.bookmarkFailed"),
        ok ? "success" : "error",
      );
    if (ok) revealBookmarkSection();
    return;
  }
  // 이미 북마크된 폴더 — 조용히 끝나면 "눌렀는데 뭔가 됐나?" 가 된다.
  if (findBookmarkId(location)) {
    useToast.getState().show(i18n.t("toast.alreadyBookmarked", { name }));
    revealBookmarkSection();
    return;
  }
  const ok = await addBookmark(name, location);
  if (ok) {
    useToast
      .getState()
      .show(i18n.t("toast.bookmarkAdded", { name }), "success");
    revealBookmarkSection();
  } else {
    useToast.getState().show(i18n.t("toast.bookmarkFailed"), "error");
  }
}

/** 접혀 있으면 펴 준다 — 추가한 항목이 화면 밖이면 추가된 걸 알 수 없다. */
function revealBookmarkSection(): void {
  const ui = useUI.getState();
  if (ui.collapsed["bookmarks"]) ui.toggleSection("bookmarks");
  if (!ui.sidebarOpen) ui.toggleSidebar();
}
