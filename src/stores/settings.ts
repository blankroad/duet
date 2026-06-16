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
}

export const useAppSettings = create<AppSettingsState>((set) => ({
  singleClickOpen: false,
  setSingleClickOpen: (v) => set({ singleClickOpen: v }),
}));
