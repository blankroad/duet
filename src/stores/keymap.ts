import { create } from "zustand";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import type { KeymapBinding } from "@/types/bindings";

interface State {
  bindings: KeymapBinding[];
  setAll: (b: KeymapBinding[]) => void;
}

export const useKeymap = create<State>((set) => ({
  bindings: [],
  setAll: (bindings) => set({ bindings }),
}));

/** override (있으면) 또는 defaultKey */
export function effectiveKey(
  commandId: string,
  bindings: KeymapBinding[],
  defaultKey?: string,
): string | undefined {
  const override = bindings.find((b) => b.command_id === commandId);
  return override?.key ?? defaultKey;
}

export async function bootstrapKeymap(): Promise<void> {
  const r = await commands.keymapList();
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
}

export async function setKeymap(
  key: string,
  commandId: string,
): Promise<boolean> {
  const r = await commands.keymapSet(key, commandId);
  if (r.status === "ok") {
    useKeymap.getState().setAll(r.data);
    return true;
  }
  return false;
}

export async function unsetKeymap(key: string): Promise<void> {
  const r = await commands.keymapUnset(key);
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
  else useToast.getState().show(`Unbind key: ${formatErr(r.error)}`, "error");
}

export async function resetKeymap(): Promise<void> {
  const r = await commands.keymapReset();
  if (r.status === "ok") useKeymap.getState().setAll(r.data);
  else useToast.getState().show(`Reset keymap: ${formatErr(r.error)}`, "error");
}
