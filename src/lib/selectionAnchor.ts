import {
  usePanes,
  activeTab,
  computeDisplayed,
  type PaneId,
} from "@/stores/panes";
import type { Location } from "@/types/bindings";
import { sameLocationDir } from "@/lib/entryDnd";

/**
 * Shift 범위 선택의 기준점 — 키보드와 마우스가 **하나**를 같이 쓴다 (탐색기/Finder 관례).
 *
 * 예전엔 키보드는 자체 Map(인덱스), 마우스 Shift-클릭은 현재 커서를 기준으로 써서
 * - 클릭 5 → Shift-클릭 10 → Shift-클릭 8 이 5..8 이 아니라 8..10 이 됐고
 * - 일반 클릭이 키보드 기준점을 지우지 않아, 클릭 뒤 Shift+↓ 가 예전 위치부터 잡혔다.
 *
 * 기준점은 탭별로 항목 **이름**을 기억한다 — 정렬·새로고침으로 인덱스가 밀려도 같은
 * 항목을 가리키게. 이름을 못 찾으면(사라짐·필터) 커서를 기준으로 삼는다.
 *
 * 규칙: Shift 없는 클릭·이동·Ctrl 토글·마키가 기준점을 정하고, Shift 클릭/이동은
 * 기준점 → 대상 범위를 선택한다(기준점은 그대로).
 */
/** 탭 id → 기준점 (그 폴더 위치와 함께 — 다른 폴더로 가면 무효). */
const anchors = new Map<string, { name: string; location: Location }>();

/**
 * 탭이 다른 폴더로 가면 그 탭의 기준점을 지운다. 위치 비교만으로는 하위 폴더에 들어갔다
 * 돌아오면(Backspace) 예전 기준점이 되살아나, 올라온 직후 Shift+↓ 가 오래전 클릭 위치부터
 * 범위를 잡았다. 같은 폴더 새로고침은 위치가 그대로라 기준점이 유지된다.
 */
usePanes.subscribe((s, prev) => {
  if (anchors.size === 0) return;
  for (const id of ["left", "right"] as const) {
    if (s.panes[id] === prev.panes[id]) continue;
    for (const t of s.panes[id].tabs) {
      const before = prev.panes[id].tabs.find((p) => p.id === t.id);
      if (before && !sameLocationDir(before.location, t.location))
        anchors.delete(t.id);
    }
  }
});

/** 기준점을 표시 목록의 `index` 항목으로 둔다. 범위 밖이면 지운다. */
export function setAnchorAt(id: PaneId, index: number): void {
  const tab = activeTab(usePanes.getState(), id);
  const name = computeDisplayed(tab)[index]?.name;
  if (name === undefined) anchors.delete(tab.id);
  else anchors.set(tab.id, { name, location: tab.location });
}

/** 기준점 → `index` 범위를 선택하고 커서를 `index` 로. */
export function selectRangeTo(id: PaneId, index: number): void {
  const state = usePanes.getState();
  const tab = activeTab(state, id);
  const a = anchors.get(tab.id);
  // 같은 탭이라도 다른 폴더로 옮겼으면 예전 기준점은 버린다 — 이름이 겹치는 새 폴더에서
  // 엉뚱한 범위가 잡히던 문제.
  const name =
    a && sameLocationDir(a.location, tab.location) ? a.name : undefined;
  const found =
    name === undefined
      ? -1
      : computeDisplayed(tab).findIndex((e) => e.name === name);
  const from = found >= 0 ? found : Math.max(0, tab.cursorIndex);
  if (found < 0) setAnchorAt(id, from);
  state.setCursor(id, index);
  state.selectRange(id, from, index);
}

/** 테스트용 — 모든 기준점 초기화. */
export function resetAnchors(): void {
  anchors.clear();
}
