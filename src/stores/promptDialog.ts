import { create } from "zustand";

/**
 * window.prompt 대체용 전역 인풋 다이얼로그 상태 — promise 기반.
 *
 * 브라우저 기본 prompt 는 테마/i18n/포커스 관리를 우회하는 유일한 이질 UI 였음.
 * 호출부는 `promptText()` 하나만 쓰면 되고(취소/닫기 = null), 렌더는
 * `PromptDialogHost`(App 루트) 가 담당.
 */
export interface PromptRequest {
  title: string;
  initial?: string;
  placeholder?: string;
}

interface State {
  req: (PromptRequest & { resolve: (v: string | null) => void }) | null;
  show: (r: PromptRequest, resolve: (v: string | null) => void) => void;
  /** 값 확정(문자열) 또는 취소(null) — 다이얼로그 닫힘. */
  settle: (v: string | null) => void;
}

export const usePromptDialog = create<State>((set, get) => ({
  req: null,
  show: (r, resolve) => {
    // 이미 열린 프롬프트가 있으면 취소로 종결 후 교체 (중첩 방지).
    get().req?.resolve(null);
    set({ req: { ...r, resolve } });
  },
  settle: (v) => {
    const req = get().req;
    set({ req: null });
    req?.resolve(v);
  },
}));

/** 텍스트 입력 프롬프트 — 확인 시 입력값, 취소/닫기 시 null. */
export function promptText(r: PromptRequest): Promise<string | null> {
  return new Promise((resolve) => usePromptDialog.getState().show(r, resolve));
}
