import { create } from "zustand";
import type { CopyPlan, DeletePlan, MovePlan, EntryRef, Location } from "@/types/bindings";

export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "progress"; title: string }
  | { kind: "settings" };

interface State {
  dialog: DialogState;
  open: (d: DialogState) => void;
  close: () => void;
}

export const useUIDialogs = create<State>((set) => ({
  dialog: { kind: "none" },
  open: (d) => set({ dialog: d }),
  close: () => set({ dialog: { kind: "none" } }),
}));
