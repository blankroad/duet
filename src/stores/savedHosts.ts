import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import type { SavedHost } from "@/types/bindings";

/**
 * 저장된 SSH 호스트 (host/port/user/key_path — 비밀번호 X, CLAUDE.md §5).
 *
 * 백엔드 `<config_dir>/duet/saved-hosts.json` 와 동기화. mount 시 list 호출,
 * upsert/remove 후 백엔드 반환값으로 store 갱신.
 */
interface State {
  hosts: SavedHost[];
  setAll: (hosts: SavedHost[]) => void;
}

export const useSavedHosts = create<State>((set) => ({
  hosts: [],
  setAll: (hosts) => set({ hosts }),
}));

/** Mount 시 백엔드에서 저장된 호스트 목록 fetch. */
export async function bootstrapSavedHosts(): Promise<void> {
  const r = await commands.savedHostsList();
  if (r.status === "ok") useSavedHosts.getState().setAll(r.data);
}

/** Upsert (alias 키, 기존 alias 면 overwrite). 성공 시 store 자동 갱신. */
export async function saveHost(host: SavedHost): Promise<boolean> {
  const r = await commands.savedHostsUpsert(host);
  if (r.status === "ok") {
    useSavedHosts.getState().setAll(r.data);
    return true;
  }
  return false;
}

/** alias 로 삭제. 없으면 no-op. */
export async function removeSavedHost(alias: string): Promise<void> {
  const r = await commands.savedHostsRemove(alias);
  if (r.status === "ok") useSavedHosts.getState().setAll(r.data);
  else useToast.getState().show(`Remove host: ${formatErr(r.error)}`);
}

/** 드래그 재정렬 — alias 순서대로. 낙관적 갱신 후 백엔드 반환값으로 정합. */
export async function reorderSavedHosts(aliases: string[]): Promise<void> {
  const prev = useSavedHosts.getState().hosts;
  const byAlias = new Map(prev.map((h) => [h.alias, h]));
  const optimistic = aliases
    .map((a) => byAlias.get(a))
    .filter((h): h is SavedHost => h !== undefined);
  useSavedHosts.getState().setAll(optimistic);
  const r = await commands.savedHostsReorder(aliases);
  if (r.status === "ok") useSavedHosts.getState().setAll(r.data);
  else useSavedHosts.getState().setAll(prev);
}
