import { create } from "zustand";
import { commands } from "@/types/bindings";
import type { AppItem } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

interface State {
  items: AppItem[];
  setAll: (items: AppItem[]) => void;
}

export const useAppLaunchers = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

/** 항목이 폴더인지 (path 없음). */
export function isAppFolder(item: AppItem): boolean {
  return item.path == null;
}

const apply = (r: { status: "ok"; data: AppItem[] } | { status: "error"; error: unknown }) => {
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
  else useToast.getState().show(`App launcher: ${formatErr(r.error)}`);
};

export async function bootstrapAppLaunchers(): Promise<void> {
  const r = await commands.appsList();
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
}

export async function addAppLauncher(name: string, path: string): Promise<void> {
  apply(await commands.appsAdd(name, path));
}
export async function renameAppLauncher(id: string, name: string): Promise<void> {
  apply(await commands.appsRename(id, name));
}
export async function setAppArgs(id: string, args: string[]): Promise<void> {
  apply(await commands.appsSetArgs(id, args));
}
export async function removeAppLauncher(id: string): Promise<void> {
  apply(await commands.appsRemove(id));
}
export async function groupApps(dragId: string, targetId: string): Promise<void> {
  apply(await commands.appsGroup(dragId, targetId));
}
export async function moveIntoFolder(appId: string, folderId: string): Promise<void> {
  apply(await commands.appsMoveIntoFolder(appId, folderId));
}
export async function moveOutOfFolder(appId: string, folderId: string): Promise<void> {
  apply(await commands.appsMoveOut(appId, folderId));
}
export async function dissolveFolder(folderId: string): Promise<void> {
  apply(await commands.appsDissolve(folderId));
}

/** 드래그 재정렬 (top-level) — id 순서. 낙관적 갱신 후 백엔드 반환값으로 정합. */
export async function reorderAppLaunchers(ids: string[]): Promise<void> {
  const prev = useAppLaunchers.getState().items;
  const byId = new Map(prev.map((a) => [a.id, a]));
  const optimistic = ids.map((id) => byId.get(id)).filter((a): a is AppItem => a !== undefined);
  useAppLaunchers.getState().setAll(optimistic);
  const r = await commands.appsReorder(ids);
  if (r.status === "ok") useAppLaunchers.getState().setAll(r.data);
  else useAppLaunchers.getState().setAll(prev);
}

export async function reorderInFolder(folderId: string, ids: string[]): Promise<void> {
  apply(await commands.appsReorderInFolder(folderId, ids));
}

/** 앱 실행 — 인자 포함. 실패 시 토스트. */
export async function launchApp(path: string, args: string[] = []): Promise<void> {
  const r = await commands.appLaunch(path, args);
  if (r.status === "error") useToast.getState().show(`Launch failed: ${formatErr(r.error)}`);
}
