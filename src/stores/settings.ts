import { create } from "zustand";
import { platform } from "@tauri-apps/plugin-os";
import type { ConflictPolicy, Settings } from "@/types/bindings";

/** 복사/이동 확인 다이얼로그를 언제 띄울지. backend `confirm_transfer` 미러. */
export type ConfirmTransfer = "always" | "conflicts_only" | "never";

const POLICIES: ConflictPolicy[] = ["skip", "keepboth", "replace"];

/** 설정 문자열 → ConflictPolicy (모르는 값은 안전한 skip). */
export function asConflictPolicy(v: string | null | undefined): ConflictPolicy {
  return POLICIES.find((p) => p === v) ?? "skip";
}

/** 설정 문자열 → ConfirmTransfer (모르는 값은 기본 conflicts_only). */
export function asConfirmTransfer(
  v: string | null | undefined,
): ConfirmTransfer {
  return v === "always" || v === "never" ? v : "conflicts_only";
}

/**
 * 런타임 설정 캐시 — backend(settings.toml)가 SoT 이고, 부팅 시(App.tsx)와
 * 저장 시(GeneralSection) 이 캐시를 동기화한다. 패널 등 UI 가 매 인터랙션마다
 * IPC 없이 즉시 읽도록 하기 위한 프론트 미러(비민감 UI 설정만).
 */
interface AppSettingsState {
  /** 단일 클릭으로 항목 열기/실행 (디폴트 false = 더블클릭). */
  singleClickOpen: boolean;
  setSingleClickOpen: (v: boolean) => void;
  /** 그리드/타일 뷰 이미지 썸네일 표시 (디폴트 true). */
  showThumbnails: boolean;
  setShowThumbnails: (v: boolean) => void;
  /** 파일 목록에 OS 네이티브 아이콘 표시 (Windows 로컬 전용, 디폴트 Windows 켬). */
  osFileIcons: boolean;
  setOsFileIcons: (v: boolean) => void;
  /** 확장자(소문자, 점 없음) → 아이콘 팔레트 이름. 유저 지정. EntryIcon 이 읽음. */
  extIconOverrides: Record<string, string>;
  setExtIconOverrides: (v: Record<string, string>) => void;
  /** 복사/이동 충돌 다이얼로그의 기본 선택 (디폴트 skip). */
  conflictDefault: ConflictPolicy;
  setConflictDefault: (v: ConflictPolicy) => void;
  /** 마지막에 고른 충돌 정책을 세션 동안 기억할지. */
  rememberConflictChoice: boolean;
  setRememberConflictChoice: (v: boolean) => void;
  /** 세션 동안 기억된 마지막 선택 (rememberConflictChoice 가 켜져 있을 때만 사용). */
  lastConflictChoice: ConflictPolicy | null;
  setLastConflictChoice: (v: ConflictPolicy) => void;
  /** 복사/이동 확인 다이얼로그 표시 시점 (디폴트 conflicts_only). */
  confirmTransfer: ConfirmTransfer;
  setConfirmTransfer: (v: ConfirmTransfer) => void;
  /** 휴지통 삭제 확인 다이얼로그 (디폴트 true). 영구 삭제는 항상 확인 — CLAUDE.md §3. */
  confirmTrashDelete: boolean;
  setConfirmTrashDelete: (v: boolean) => void;
}

/**
 * 충돌 다이얼로그가 처음 고를 정책 — "기억하기"가 켜져 있으면 세션의 마지막 선택,
 * 아니면 설정의 기본값.
 */
export function initialConflictPolicy(): ConflictPolicy {
  const s = useAppSettings.getState();
  return (
    (s.rememberConflictChoice && s.lastConflictChoice) || s.conflictDefault
  );
}

export const useAppSettings = create<AppSettingsState>((set) => ({
  singleClickOpen: false,
  setSingleClickOpen: (v) => set({ singleClickOpen: v }),
  showThumbnails: true,
  setShowThumbnails: (v) => set({ showThumbnails: v }),
  // 부팅 sync(App.tsx) 전 초깃값 — backend 디폴트(Windows 켬)와 곧 동기화됨.
  osFileIcons: false,
  setOsFileIcons: (v) => set({ osFileIcons: v }),
  extIconOverrides: {},
  setExtIconOverrides: (v) => set({ extIconOverrides: v }),
  conflictDefault: "skip",
  setConflictDefault: (v) => set({ conflictDefault: v }),
  rememberConflictChoice: false,
  setRememberConflictChoice: (v) => set({ rememberConflictChoice: v }),
  lastConflictChoice: null,
  setLastConflictChoice: (v) => set({ lastConflictChoice: v }),
  confirmTransfer: "conflicts_only",
  setConfirmTransfer: (v) => set({ confirmTransfer: v }),
  confirmTrashDelete: true,
  setConfirmTrashDelete: (v) => set({ confirmTrashDelete: v }),
}));

/** backend Settings → 프론트 미러 동기화 (부팅·저장 시 공통). */
export function syncAppSettings(s: Settings): void {
  const st = useAppSettings.getState();
  st.setSingleClickOpen(s.single_click_open ?? false);
  st.setShowThumbnails(s.show_thumbnails ?? true);
  st.setOsFileIcons(s.os_file_icons ?? platform() === "windows");
  st.setConflictDefault(asConflictPolicy(s.transfer_conflict_default));
  st.setRememberConflictChoice(s.remember_conflict_choice ?? false);
  st.setConfirmTransfer(asConfirmTransfer(s.confirm_transfer));
  st.setConfirmTrashDelete(s.confirm_trash_delete ?? true);
}
