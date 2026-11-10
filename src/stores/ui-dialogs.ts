import { create } from "zustand";
import type {
  CopyPlan,
  DeletePlan,
  MovePlan,
  EntryRef,
  Location,
  Volume,
  CompressPlan,
  SyncPlan,
  ComparePlan,
  CompareRules,
  ThreeWayPlan,
  ExtractPlanItem,
} from "@/types/bindings";
import type { PaneId } from "@/stores/panes";
import type { ElevatablePlan } from "@/lib/elevatePending";
import type { ExtractRetry } from "@/lib/extractPending";

export type DialogState =
  | { kind: "none" }
  // 단일 rename 은 인라인 편집(useUI.renameTarget)으로 대체 — 다이얼로그 없음.
  | { kind: "batch-rename"; targets: EntryRef[] }
  | { kind: "mkdir"; parent: Location; tabId?: string }
  | { kind: "new-file"; parent: Location; tabId?: string }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  // 가상 휴지통(Windows Recycle Bin) 영구 삭제 / 비우기(all).
  | { kind: "trash-purge"; names: string[]; all: boolean }
  | { kind: "copy-confirm"; plan: CopyPlan }
  // 보호 경로 copy/move/delete 가 PermissionDenied 로 실패 → 승격 재시도.
  // 로컬=UAC(elevate-op), 원격=sudo(sudo-op→필요 시 sudo-password).
  | { kind: "elevate-op"; pending: ElevatablePlan }
  | { kind: "sudo-op"; pending: ElevatablePlan }
  | { kind: "sudo-password"; pending: ElevatablePlan; error?: boolean }
  // clip = 잘라내기 붙여넣기의 클립보드 번호 — 실행이 접수되면 그 항목을 클립보드에서 뺀다.
  | { kind: "move-confirm"; plan: MovePlan; clip?: number }
  | { kind: "compress"; items: EntryRef[]; defaultName: string }
  // wrong=true 는 직전 암호가 틀려 task 가 NeedPassword 로 실패한 재시도.
  // promptId = 이 프롬프트만의 id (React key·닫기 대상 확인 — 같은 이름 아카이브도 구분).
  | {
      kind: "extract-password";
      promptId: string;
      retry: ExtractRetry;
      wrong?: boolean;
    }
  // 각각 폴더로 풀기 — 받을 이름이 이미 있음: 교체 / 둘 다 유지 / 취소 (일괄 1회).
  | { kind: "extract-conflict"; items: ExtractPlanItem[] }
  // 여기에 풀기 — 아카이브 목록 + 이미 있는 항목 정책 (늘 묻는다).
  | { kind: "extract-here"; archives: EntryRef[] }
  | {
      kind: "browse-password";
      paneId: PaneId;
      archive: EntryRef;
      /** 열기를 시작한 탭 — 암호를 묻는 사이 탭을 바꿔도 그 탭에 연다. */
      tabId?: string;
    }
  | { kind: "repack-confirm"; plan: CompressPlan; label: string }
  | { kind: "sync-confirm"; plan: SyncPlan; srcLabel: string; dstLabel: string }
  /** rules = 이 plan 을 만든 비교 규칙 — 머지가 같은 규칙으로 다시 비교한다(SC-07). */
  | { kind: "compare"; plan: ComparePlan; rules: CompareRules }
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
  | { kind: "settings" }
  | { kind: "shortcuts" }
  | { kind: "history" };

interface State {
  dialog: DialogState;
  /** `openWhenFree` 로 미뤄 둔 대화상자 — 지금 창이 닫히면 차례로 연다. */
  queue: DialogState[];
  /** 지금 창이 대기열에서 나온 것인가 — `open` 이 그 위를 덮으면 대기열로 되돌린다. */
  fromQueue: boolean;
  open: (d: DialogState) => void;
  /**
   * 사용자가 쓰던 대화상자를 갈아치우지 않는 열기 — 백그라운드 작업이 묻는 것
   * (sudo·권한 상승·압축 암호)용. 아무것도 없거나 진행률 창이면 바로 열고, 아니면
   * 대기열에 넣는다. 반환값 = 바로 열렸는가. 예전엔 이름변경 규칙·비교 결정 등을
   * 입력하던 창이 예고 없이 사라졌다.
   */
  openWhenFree: (d: DialogState) => boolean;
  close: () => void;
}

export const useUIDialogs = create<State>((set, get) => ({
  dialog: { kind: "none" },
  queue: [],
  fromQueue: false,
  // 확정 핸들러는 흔히 close() 직후 open(진행률 등)을 부른다 — close 가 대기열에서 꺼낸
  // 창을 그 open 이 덮어 잃지 않게, 대기열 맨 앞으로 되돌린다.
  open: (d) =>
    // open({ kind: "none" }) 로 닫는 경로도 있다(비교 스캔 취소 등) — close 와 같게.
    d.kind === "none"
      ? get().close()
      : set((s) =>
          s.fromQueue && s.dialog.kind !== "none"
            ? { dialog: d, queue: [s.dialog, ...s.queue], fromQueue: false }
            : { dialog: d, fromQueue: false },
        ),
  openWhenFree: (d) => {
    const cur = get().dialog.kind;
    if (cur === "none" || cur === "progress") {
      set({ dialog: d, fromQueue: false });
      return true;
    }
    set((s) => ({ queue: [...s.queue, d] }));
    return false;
  },
  close: () =>
    set((s) => {
      const [next, ...rest] = s.queue;
      return {
        dialog: next ?? { kind: "none" },
        queue: rest,
        fromQueue: next !== undefined,
      };
    }),
}));
