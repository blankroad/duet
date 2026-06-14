import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { Place, Volume } from "@/types/bindings";

/** 표준 Places(Home/Desktop/…) + 마운트 Volumes. 둘 다 backend 가 OS별 해석. */
interface State {
  places: Place[];
  volumes: Volume[];
  setPlaces: (p: Place[]) => void;
  setVolumes: (v: Volume[]) => void;
}

export const usePlaces = create<State>((set) => ({
  places: [],
  volumes: [],
  setPlaces: (places) => set({ places }),
  setVolumes: (volumes) => set({ volumes }),
}));

export async function bootstrapPlaces(): Promise<void> {
  const [p, v] = await Promise.all([commands.places(), commands.volumes()]);
  if (p.status === "ok") usePlaces.getState().setPlaces(p.data);
  if (v.status === "ok") usePlaces.getState().setVolumes(v.data);
}

/** 볼륨만 새로고침 (마운트/언마운트 반영). */
export async function refreshVolumes(): Promise<void> {
  const v = await commands.volumes();
  if (v.status === "ok") usePlaces.getState().setVolumes(v.data);
}
