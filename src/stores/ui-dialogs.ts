import { create } from "zustand";
import type { CopyPlan, DeletePlan, MovePlan, EntryRef, Location, Volume, CompressPlan, SyncPlan, ComparePlan, ThreeWayPlan, ExtractPlan } from "@/types/bindings";
import type { PaneId } from "@/stores/panes";
import type { ElevatablePlan } from "@/lib/elevatePending";

export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "batch-rename"; targets: EntryRef[] }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  // 보호 경로 copy/move/delete 가 PermissionDenied 로 실패 → 승격 재시도.
  // 로컬=UAC(elevate-op), 원격=sudo(sudo-op→필요 시 sudo-password).
  | { kind: "elevate-op"; pending: ElevatablePlan }
  | { kind: "sudo-op"; pending: ElevatablePlan }
  | { kind: "sudo-password"; pending: ElevatablePlan; error?: boolean }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "compress"; items: EntryRef[]; defaultName: string }
  // wrong=true 는 직전 암호가 틀려 task 가 NeedPassword 로 실패한 재시도.
  | { kind: "extract-password"; plan: ExtractPlan; wrong?: boolean }
  | { kind: "browse-password"; paneId: PaneId; archive: EntryRef }
  | { kind: "repack-confirm"; plan: CompressPlan; label: string }
  | { kind: "sync-confirm"; plan: SyncPlan; srcLabel: string; dstLabel: string }
  | { kind: "compare"; plan: ComparePlan }
  | { kind: "compare-scanning" }
  | { kind: "three-way"; plan: ThreeWayPlan }
  | { kind: "checksum"; targets: EntryRef[] }
  // remote=ssh(소유자 편집 노출), initialMode=선택 항목 공통 mode(다르면 null).
  | {
      kind: "permissions";
      targets: EntryRef[];
      initialMode: number | null;
      remote: boolean;
      hasDir: boolean;
    }
  | { kind: "symlink"; parent: Location }
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
