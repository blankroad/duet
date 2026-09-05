import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import i18n from "@/i18n";
import type { HostFavorite } from "@/types/bindings";

interface State {
  items: HostFavorite[];
  setAll: (items: HostFavorite[]) => void;
}

export const useHostFavorites = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapHostFavorites(): Promise<void> {
  const r = await commands.hostFavoritesList();
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
}

export async function addHostFavorite(
  host_alias: string,
  name: string,
  path: string,
): Promise<boolean> {
  const r = await commands.hostFavoritesAdd(host_alias, name, path);
  if (r.status === "ok") {
    useHostFavorites.getState().setAll(r.data);
    return true;
  }
  return false;
}

/** 이름만 변경 — 경로·순서·태그는 그대로. */
export async function renameHostFavorite(
  id: string,
  name: string,
): Promise<void> {
  const r = await commands.hostFavoritesRename(id, name);
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
  else
    useToast
      .getState()
      .show(i18n.t("toast.renameFailed", { err: formatErr(r.error) }), "error");
}

/**
 * 이 (호스트, 경로) 의 즐겨찾기 id — 없으면 null.
 * PathBar 의 ★ 상태와 Ctrl+D 토글이 원격에서도 동작하게 하는 조회.
 */
export function findHostFavoriteId(
  hostAlias: string,
  path: string,
): string | null {
  const hit = useHostFavorites
    .getState()
    .items.find((f) => f.host_alias === hostAlias && String(f.path) === path);
  return hit?.id ?? null;
}

export async function removeHostFavorite(id: string): Promise<void> {
  const r = await commands.hostFavoritesRemove(id);
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
  else
    useToast
      .getState()
      .show(
        i18n.t("toast.removeFavoriteFailed", { err: formatErr(r.error) }),
        "error",
      );
}

/**
 * 한 alias 그룹 내 재정렬 — 그 그룹의 id 들을 새 순서로 보냄. 백엔드는 해당 id 가
 * 차지하던 슬롯에만 새 순서를 채워 다른 그룹 위치는 보존.
 */
export async function reorderHostFavorites(ids: string[]): Promise<void> {
  const prev = useHostFavorites.getState().items;
  const r = await commands.hostFavoritesReorder(ids);
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
  else useHostFavorites.getState().setAll(prev);
}
