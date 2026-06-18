import { create } from "zustand";
import type { EntryRef } from "@/types/bindings";

/** 붙여넣기 모드 — copy(원본 유지) / move(잘라내기, 붙여넣으면 원본 제거). */
export type ClipMode = "copy" | "move";

/**
 * 인앱 파일 클립보드 — Ctrl+C/Ctrl+X 로 담고 Ctrl+V 로 붙여넣는다.
 * OS 클립보드가 아니라(파일 핸들 통합은 후속) 세션 메모리상의 큐.
 * 항목은 원본 location 을 들고 있어 다른 폴더/패널/소스로 이동해도 붙여넣기가 된다.
 */
interface ClipboardState {
  entry: { targets: EntryRef[]; mode: ClipMode } | null;
  set: (targets: EntryRef[], mode: ClipMode) => void;
  clear: () => void;
}

export const useClipboard = create<ClipboardState>((set) => ({
  entry: null,
  set: (targets, mode) => set({ entry: { targets, mode } }),
  clear: () => set({ entry: null }),
}));
