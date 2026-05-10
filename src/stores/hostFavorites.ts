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
