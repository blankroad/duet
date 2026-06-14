import { create } from "zustand";
import { commands } from "@/types/bindings";
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

export async function removeHostFavorite(id: string): Promise<void> {
  const r = await commands.hostFavoritesRemove(id);
  if (r.status === "ok") useHostFavorites.getState().setAll(r.data);
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
