import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { AppLauncher } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

interface State {
  items: AppLauncher[];
  setAll: (items: AppLauncher[]) => void;
}

export const useAppLaunchers = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapAppLaunchers(): Promise<void> {
  const r = await commands.appsList();
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
}

export async function addAppLauncher(name: string, path: string): Promise<void> {
  const r = await commands.appsAdd(name, path);
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
  else useToast.getState().show(`Add app failed: ${formatErr(r.error)}`);
}

export async function renameAppLauncher(id: string, name: string): Promise<void> {
  const r = await commands.appsRename(id, name);
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
}

export async function removeAppLauncher(id: string): Promise<void> {
  const r = await commands.appsRemove(id);
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
}

/** 드래그 재정렬 — id 순서. 낙관적 갱신 후 백엔드 반환값으로 정합. */
export async function reorderAppLaunchers(ids: string[]): Promise<void> {
  const prev = useAppLaunchers.getState().items;
  const byId = new Map(prev.map((a) => [a.id, a]));
  const optimistic = ids.map((id) => byId.get(id)).filter((a): a is AppLauncher => a !== undefined);
  useAppLaunchers.getState().setAll(optimistic);
  const r = await commands.appsReorder(ids);
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
  else useAppLaunchers.getState().setAll(prev);
}

/** 앱 실행 — 실패 시 토스트(앱 이동/삭제 등). */
export async function launchApp(path: string): Promise<void> {
  const r = await commands.appLaunch(path);
  if (r.status === "error") useToast.getState().show(`Launch failed: ${formatErr(r.error)}`);
}
