import { create } from "zustand";
import { reorderInSlots } from "@/lib/reorderSlots";
import i18n from "@/i18n";
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
  else
    useToast
      .getState()
      .show(
        i18n.t("toast.removeHostFailed", { err: formatErr(r.error) }),
        "error",
      );
}

/** 드래그 재정렬 — alias 순서대로. 낙관적 갱신 후 백엔드 반환값으로 정합. */
export async function reorderSavedHosts(aliases: string[]): Promise<void> {
  const prev = useSavedHosts.getState().hosts;
  // 그룹 밖 항목만 끌어도 그룹 멤버를 지우지 않게 — 자리 채우기(백엔드와 같은 규칙).
  const optimistic = reorderInSlots(prev, (h) => h.alias, aliases);
  useSavedHosts.getState().setAll(optimistic);
  const r = await commands.savedHostsReorder(aliases);
  if (r.status === "ok") useSavedHosts.getState().setAll(r.data);
  else useSavedHosts.getState().setAll(prev);
}
