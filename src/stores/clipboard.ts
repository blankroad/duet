import { create } from "zustand";
import type { EntryRef } from "@/types/bindings";
import { sameLocationDir } from "@/lib/entryDnd";

/** 붙여넣기 모드 — copy(원본 유지) / move(잘라내기, 붙여넣으면 원본 제거). */
export type ClipMode = "copy" | "move";

/** Ctrl+C/Ctrl+X 한 번이 만든 클립보드 내용. `id` 는 그 한 번을 가리킨다. */
export interface ClipEntry {
  /** 담을 때마다 새로 받는 번호 — 늦게 끝난 붙여넣기가 새 내용을 지우지 않게 비교한다. */
  id: number;
  targets: EntryRef[];
  mode: ClipMode;
}

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
  entry: ClipEntry | null;
  set: (targets: EntryRef[], mode: ClipMode) => void;
  clear: () => void;
  /**
   * 잘라내기 붙여넣기에서 이동 작업이 **실제로 접수된** 항목만 클립보드에서 뺀다.
   * `id` 가 지금 내용과 다르면(그 사이 새로 Ctrl+C/Ctrl+X) 아무것도 하지 않는다.
   * 복사 클립보드는 여러 번 붙여넣을 수 있게 그대로 둔다.
   */
  consume: (id: number, moved: EntryRef[]) => void;
}

let nextId = 1;

const sameRef = (a: EntryRef, b: EntryRef) =>
  a.name === b.name && sameLocationDir(a.location, b.location);

export const useClipboard = create<ClipboardState>((set, get) => ({
  entry: null,
  set: (targets, mode) => set({ entry: { id: nextId++, targets, mode } }),
  clear: () => set({ entry: null }),
  consume: (id, moved) => {
    const cur = get().entry;
    if (!cur || cur.id !== id || cur.mode !== "move") return;
    const left = cur.targets.filter((t) => !moved.some((m) => sameRef(t, m)));
    if (left.length === cur.targets.length) return;
    set({ entry: left.length > 0 ? { ...cur, targets: left } : null });
  },
}));
