/**
 * 백엔드 plan 의 `EntryRef`(위치+이름) 를 화면용 항목(종류·크기 포함)으로 보강.
 *
 * plan 은 이름만 나르므로 아이콘/크기를 그리려면 열려 있는 패널의 entries 에서
 * 찾아야 한다 — 확인 다이얼로그는 항상 어떤 패널의 선택에서 시작하니 거의 항상
 * 맞는 탭이 있다. 없으면(탭을 닫았거나 다른 폴더로 이동) kind/size 는 null 로 두고
 * 파일 아이콘으로 폴백한다. 표시 전용 — 경로 결합/검증은 하지 않는다 (CLAUDE.md §7).
 */
import { usePanes } from "@/stores/panes";
import type { Entry, EntryRef, Location, SourceId } from "@/types/bindings";

export interface PlanItem {
  name: string;
  kind: Entry["kind"] | null;
  size: number | null;
}

function sameSource(a: SourceId, b: SourceId): boolean {
  if (a.kind === "local" || b.kind === "local") return a.kind === b.kind;
  return a.connection_id === b.connection_id;
}

function sameLocation(a: Location, b: Location): boolean {
  return a.path === b.path && sameSource(a.source, b.source);
}

/** 열린 탭 중 `location` 을 보고 있는 첫 탭의 entries (이름 → Entry). 없으면 빈 Map. */
export function entriesAt(location: Location): Map<string, Entry> {
  const s = usePanes.getState();
  for (const id of ["left", "right"] as const) {
    for (const tab of s.panes[id].tabs) {
      if (sameLocation(tab.location, location)) {
        return new Map(tab.entries.map((e) => [e.name, e]));
      }
    }
  }
  return new Map();
}

/** EntryRef 목록 → 표시 항목. 같은 위치의 항목은 탭 조회를 한 번만 한다. */
export function resolvePlanItems(refs: EntryRef[]): PlanItem[] {
  const cache = new Map<string, Map<string, Entry>>();
  return refs.map((r) => {
    const key = `${r.location.source.kind}:${r.location.path}`;
    let entries = cache.get(key);
    if (!entries) {
      entries = entriesAt(r.location);
      cache.set(key, entries);
    }
    const e = entries.get(r.name);
    return { name: r.name, kind: e?.kind ?? null, size: e?.size ?? null };
  });
}
