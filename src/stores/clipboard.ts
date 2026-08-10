import { create } from "zustand";
import type { EntryRef } from "@/types/bindings";

/** 붙여넣기 모드 — copy(원본 유지) / move(잘라내기, 붙여넣으면 원본 제거). */
export type ClipMode = "copy" | "move";

/**
 * 인앱 파일 클립보드 — Ctrl+C/Ctrl+X 로 담고 Ctrl+V 로 붙여넣는다.
 * 세션 메모리상의 큐이며, 항목은 원본 location 을 들고 있어 다른 폴더/패널/소스로 이동해도
 * 붙여넣기가 된다(원격 소스 포함 — 그래서 OS 클립보드로 대체하지 않는다).
 *
 * 로컬 항목은 복사 시 `fileActions.mirrorToOsClipboard` 가 **OS 클립보드에도** 같은 파일을
 * 올린다(Finder/탐색기 붙여넣기·클립보드 동기화 도구 인식용). 즉 이 큐는 duet 내부의
 * 진실이고, OS 클립보드는 그 미러다.
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
