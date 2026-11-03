import {
  usePanes,
  activeTab,
  computeDisplayed,
  type PaneId,
} from "@/stores/panes";

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
const anchors = new Map<string, string>();

function tabKey(id: PaneId): string {
  return activeTab(usePanes.getState(), id).id;
}

/** 기준점을 표시 목록의 `index` 항목으로 둔다. 범위 밖이면 지운다. */
export function setAnchorAt(id: PaneId, index: number): void {
  const name = computeDisplayed(activeTab(usePanes.getState(), id))[index]
    ?.name;
  if (name === undefined) anchors.delete(tabKey(id));
  else anchors.set(tabKey(id), name);
}

/** 기준점 → `index` 범위를 선택하고 커서를 `index` 로. */
export function selectRangeTo(id: PaneId, index: number): void {
  const state = usePanes.getState();
  const tab = activeTab(state, id);
  const name = anchors.get(tab.id);
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
