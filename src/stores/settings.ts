import { create } from "zustand";

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
  /** 확장자(소문자, 점 없음) → 아이콘 팔레트 이름. 유저 지정. EntryIcon 이 읽음. */
  extIconOverrides: Record<string, string>;
  setExtIconOverrides: (v: Record<string, string>) => void;
}

export const useAppSettings = create<AppSettingsState>((set) => ({
  singleClickOpen: false,
  setSingleClickOpen: (v) => set({ singleClickOpen: v }),
  showThumbnails: true,
  setShowThumbnails: (v) => set({ showThumbnails: v }),
  extIconOverrides: {},
  setExtIconOverrides: (v) => set({ extIconOverrides: v }),
}));
