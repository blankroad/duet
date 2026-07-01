import { create } from "zustand";
import type { CopyPlan, DeletePlan, MovePlan, EntryRef, Location, Volume, CompressPlan, SyncPlan, ComparePlan, ThreeWayPlan, ExtractPlan, ConflictPolicy } from "@/types/bindings";
import type { PaneId } from "@/stores/panes";

export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "batch-rename"; targets: EntryRef[] }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  // 보호 폴더 복사가 PermissionDenied 로 실패 → 관리자 승격 재시도 확인.
  | { kind: "elevate-copy"; plan: CopyPlan; policy: ConflictPolicy }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "compress"; items: EntryRef[]; defaultName: string }
  | { kind: "extract-password"; plan: ExtractPlan }
  | { kind: "browse-password"; paneId: PaneId; archive: EntryRef }
  | { kind: "repack-confirm"; plan: CompressPlan; label: string }
  | { kind: "sync-confirm"; plan: SyncPlan; srcLabel: string; dstLabel: string }
  | { kind: "compare"; plan: ComparePlan }
  | { kind: "compare-scanning" }
  | { kind: "three-way"; plan: ThreeWayPlan }
  | { kind: "app-args"; appId: string; name: string; args: string[] }
  | { kind: "eject-confirm"; volume: Volume }
  | { kind: "progress"; title: string; taskId: string }
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
