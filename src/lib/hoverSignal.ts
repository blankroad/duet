import type { Entry } from "@/types/bindings";
import type { PaneId } from "@/stores/panes";

/**
 * 항목 호버 신호 — "마우스가 이 항목 위에 올라왔다"만 알린다.
 *
 * 스토어가 아니라 순수 pub/sub 인 이유: 리스트 위를 지나가는 마우스는 초당 수십 번
 * 발화하는데, 이걸 스토어에 넣으면 구독 컴포넌트가 전부 리렌더된다. 구독자는
 * 리렌더가 필요 없는 부수효과(useShellWarm 의 셸 메뉴 예열)뿐이다.
 *
 * 미리보기 호버(`stores/previewHover`)와 달리 **미리보기 패널 열림 여부와 무관하게**
 * 항상 발화한다.
 */
type HoverListener = (paneId: PaneId, entry: Entry) => void;

const listeners = new Set<HoverListener>();

/** 호버 신호 구독 — 해제 함수 반환. */
export function onHoverEntry(fn: HoverListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 호버 신호 발화 — 행/타일의 mouseenter 에서. 구독자 없으면 사실상 no-op. */
export function emitHoverEntry(paneId: PaneId, entry: Entry): void {
  for (const fn of listeners) fn(paneId, entry);
}
