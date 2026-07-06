import { create } from "zustand";
import type { EntryRef } from "@/types/bindings";
import { sourceKey } from "@/lib/entryDnd";

/**
 * Shelf — 여러 위치·여러 호스트에서 모은 항목 보관함. **섹션(영역)으로 나눠** 담아
 * 섹션 단위로 활성 패널에 복사/이동한다("넓게 모아서 → 버킷째 뿌리기").
 *
 * 항목 = `EntryRef`({ location: 부모폴더, name }). dedup 은 **전역**(한 항목은 한 섹션에만).
 * 새 항목은 **타깃 섹션**(`targetId`)으로 들어간다 — 담기 전 타깃을 바꿔 분류. 적용은
 * fileActions.applyShelfTo 가 기존 plan/execute 재사용(IPC 신규 없음). 세션 내 메모리만
 * (영속은 후속 — SSH 항목 connection_id 가 재시작 시 무효라 별도 처리 필요).
 */

/** 항목 dedup/제거 키 — 소스 + 부모경로 + 이름. */
export function shelfKey(ref: EntryRef): string {
  return `${sourceKey(ref.location.source)}|${ref.location.path}|${ref.name}`;
}

export interface ShelfSection {
  id: string;
  name: string;
  items: EntryRef[];
}

let seq = 0;
const newId = () => `sec${(seq += 1)}`;

interface ShelfState {
  sections: ShelfSection[];
  /** 새 항목이 담기는 섹션. */
  targetId: string;
  /** 타깃 섹션에 추가(전역 중복 제외). 새로 담긴 개수 반환. */
  add: (refs: EntryRef[]) => number;
  /** 키로 단건 제거(어느 섹션이든). */
  remove: (key: string) => void;
  /** 전체 항목 비우기(섹션 구조 유지). */
  clear: () => void;
  /** 한 섹션 항목만 비우기. */
  clearSection: (id: string) => void;
  /** 항목을 다른 섹션으로 이동. */
  moveItem: (key: string, toId: string) => void;
  /** 새 섹션 추가 → 타깃으로. id 반환. */
  newSection: (name: string) => string;
  renameSection: (id: string, name: string) => void;
  /** 섹션 삭제(항목째). 최소 1개는 유지. */
  deleteSection: (id: string) => void;
  setTarget: (id: string) => void;
}

const firstId = newId();

export const useShelf = create<ShelfState>((set, get) => ({
  sections: [{ id: firstId, name: "Main", items: [] }],
  targetId: firstId,

  add: (refs) => {
    const s = get();
    const seen = new Set(s.sections.flatMap((sec) => sec.items.map(shelfKey)));
    const fresh = refs.filter((r) => {
      const k = shelfKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (fresh.length === 0) return 0;
    set({
      sections: s.sections.map((sec) =>
        sec.id === s.targetId ? { ...sec, items: [...sec.items, ...fresh] } : sec,
      ),
    });
    return fresh.length;
  },

  remove: (key) =>
    set((s) => ({
      sections: s.sections.map((sec) => ({
        ...sec,
        items: sec.items.filter((r) => shelfKey(r) !== key),
      })),
    })),

  clear: () =>
    set((s) => ({ sections: s.sections.map((sec) => ({ ...sec, items: [] })) })),

  clearSection: (id) =>
    set((s) => ({
      sections: s.sections.map((sec) =>
        sec.id === id ? { ...sec, items: [] } : sec,
      ),
    })),

  moveItem: (key, toId) =>
    set((s) => {
      let moved: EntryRef | undefined;
      const stripped = s.sections.map((sec) => {
        const keep: EntryRef[] = [];
        for (const r of sec.items) {
          if (shelfKey(r) === key && !moved) moved = r;
          else keep.push(r);
        }
        return { ...sec, items: keep };
      });
      if (!moved) return s;
      const m = moved;
      return {
        sections: stripped.map((sec) =>
          sec.id === toId ? { ...sec, items: [...sec.items, m] } : sec,
        ),
      };
    }),

  newSection: (name) => {
    const id = newId();
    set((s) => ({
      sections: [...s.sections, { id, name, items: [] }],
      targetId: id,
    }));
    return id;
  },

  renameSection: (id, name) =>
    set((s) => ({
      sections: s.sections.map((sec) =>
        sec.id === id ? { ...sec, name } : sec,
      ),
    })),

  deleteSection: (id) =>
    set((s) => {
      if (s.sections.length <= 1) return s;
      const sections = s.sections.filter((sec) => sec.id !== id);
      const targetId = s.targetId === id ? sections[0]!.id : s.targetId;
      return { sections, targetId };
    }),

  setTarget: (id) => set({ targetId: id }),
}));

/** 특정 섹션의 항목 (없으면 첫 섹션). fileActions/apply 에서 사용. */
export function shelfSectionItems(id?: string): EntryRef[] {
  const s = useShelf.getState();
  const sec = s.sections.find((x) => x.id === (id ?? s.targetId)) ?? s.sections[0];
  return sec?.items ?? [];
}
