import { create } from "zustand";
import type { CopyPlan, DeletePlan, MovePlan, EntryRef, Location } from "@/types/bindings";

/**
 * MVP-3: rsync 등 진행 중 op 의 progress 정보. ProgressModal 이 표시.
 *
 * 모든 필드 nullable — rsync 가 모를 때 null. percent null 면 spinner.
 */
export interface ProgressInfo {
  bytesDone: number;
  bytesTotal: number | null;
  speedBps: number | null;
  etaSec: number | null;
  percent: number | null;
}

export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "progress"; title: string; progress?: ProgressInfo }
  | { kind: "settings" };

interface State {
  dialog: DialogState;
  open: (d: DialogState) => void;
  close: () => void;
  /** Update progress on current 'progress' dialog. No-op otherwise. */
  setProgress: (p: ProgressInfo) => void;
}

export const useUIDialogs = create<State>((set) => ({
  dialog: { kind: "none" },
  open: (d) => set({ dialog: d }),
  close: () => set({ dialog: { kind: "none" } }),
  setProgress: (p) =>
    set((s) =>
      s.dialog.kind === "progress"
        ? { dialog: { ...s.dialog, progress: p } }
        : s,
    ),
}));
