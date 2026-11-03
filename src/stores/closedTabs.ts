import type { PaneId, TabState } from "./panes";

/**
 * 최근 닫은 탭 스택 — "닫은 탭 다시 열기"(Ctrl+Shift+T) 용. 메모리에만 둔다
 * (재시작하면 비어도 되는 실수 복구 장치). 목록(entries)은 버리고 위치·정렬·보기·
 * 히스토리·핀 같은 탭 문맥만 보관한다.
 */
export interface ClosedTab {
  pane: PaneId;
  /** 닫히기 전 그 패널에서의 위치 — 다시 열 때 이 자리 근처로 돌아간다. */
  index: number;
  tab: TabState;
}

const MAX = 25;
let stack: ClosedTab[] = [];

/** 닫힌 탭 기록. 일괄 닫기는 왼쪽부터 넣는다 — 다시 열면 오른쪽부터 제자리로. */
export function pushClosedTabs(items: ClosedTab[]): void {
  if (items.length === 0) return;
  stack.push(...items.map((c) => ({ ...c, tab: { ...c.tab, entries: [] } })));
  if (stack.length > MAX) stack = stack.slice(stack.length - MAX);
}

/** 가장 최근에 닫힌 탭을 꺼낸다 (없으면 undefined). */
export function popClosedTab(): ClosedTab | undefined {
  return stack.pop();
}

/** 다시 열 탭이 있는가 — 메뉴 활성화 판단용. */
export function hasClosedTabs(): boolean {
  return stack.length > 0;
}

/** 테스트용 초기화. */
export function clearClosedTabs(): void {
  stack = [];
}
