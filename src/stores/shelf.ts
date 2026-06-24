import { create } from "zustand";
import type { EntryRef } from "@/types/bindings";
import { sourceKey } from "@/lib/entryDnd";

/**
 * Drop Stack / Shelf — 여러 위치·여러 호스트에서 모은 항목 보관함.
 *
 * 항목 = `EntryRef`({ location: 부모폴더, name }). 적용(복사/이동)은 fileActions
 * 의 applyShelfTo 가 기존 plan/execute 흐름으로 처리(IPC 신규 없음). 세션 내 메모리만.
 */

/** 항목 dedup/제거 키 — 소스 + 부모경로 + 이름. */
export function shelfKey(ref: EntryRef): string {
  return `${sourceKey(ref.location.source)}|${ref.location.path}|${ref.name}`;
}

interface ShelfState {
  items: EntryRef[];
  /** 항목 추가(중복 제외). 새로 담긴 개수 반환. */
  add: (refs: EntryRef[]) => number;
  /** 키로 단건 제거. */
  remove: (key: string) => void;
  /** 전체 비우기. */
  clear: () => void;
}

export const useShelf = create<ShelfState>((set, get) => ({
  items: [],
  add: (refs) => {
    const cur = get().items;
    const seen = new Set(cur.map(shelfKey));
    const fresh = refs.filter((r) => {
      const k = shelfKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length > 0) set({ items: [...cur, ...fresh] });
    return fresh.length;
  },
  remove: (key) => set((s) => ({ items: s.items.filter((r) => shelfKey(r) !== key) })),
  clear: () => set({ items: [] }),
}));
