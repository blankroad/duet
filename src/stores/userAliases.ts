import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import type { AliasKind, UserAlias } from "@/types/bindings";

interface State {
  items: UserAlias[];
  setAll: (items: UserAlias[]) => void;
}

export const useUserAliases = create<State>((set) => ({
  items: [],
  setAll: (items) => set({ items }),
}));

export async function bootstrapUserAliases(): Promise<void> {
  const r = await commands.userAliasesList();
  if (r.status === "ok") useUserAliases.getState().setAll(r.data);
}

export async function addUserAlias(name: string, kind: AliasKind): Promise<boolean> {
  const r = await commands.userAliasesAdd(name, kind);
  if (r.status === "ok") {
    useUserAliases.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function removeUserAlias(id: string): Promise<void> {
  const r = await commands.userAliasesRemove(id);
  if (r.status === "ok") useUserAliases.getState().setAll(r.data);
  else useToast.getState().show(`Remove alias: ${formatErr(r.error)}`);
}
