import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { childLocation } from "@/lib/entryDnd";
import { emitHoverEntry } from "@/lib/hoverSignal";

/**
 * 호버 미리보기 — 마우스가 올라간 항목으로 미리보기/인스펙터 패널을 갱신.
 * 리스트를 벗어나면 null → 패널은 커서 항목으로 복귀(PreviewPane 에서 처리).
 * 미리보기 패널이 닫혀 있으면 set 자체를 생략(불필요한 fetch/리렌더 회피).
 */
interface HoverState {
  target: { entry: Entry; location: Location; paneId: PaneId } | null;
  set: (t: { entry: Entry; location: Location; paneId: PaneId } | null) => void;
}

export const usePreviewHover = create<HoverState>((set) => ({
  target: null,
  set: (target) => set({ target }),
}));

/** 마지막 호버 이벤트의 포인터 위치 — 포인터는 그대로인데 행만 움직인 경우 판별. */
let lastPoint: { x: number; y: number } | null = null;

/**
 * 패널이 열려 있을 때만, 호버한 항목(`..` 제외)을 대상으로 설정.
 *
 * `point` 를 주면 포인터가 실제로 움직였을 때만 미리보기 대상을 바꾼다. 키보드로 커서를
 * 옮겨 목록이 스크롤되면 가만히 있는 포인터 아래로 다른 행이 지나가며 mouseenter 가
 * 생기는데, 이걸 호버로 받으면 미리보기가 커서 대신 그 행을 보여 준다.
 */
export function setHoverEntry(
  id: PaneId,
  entry: Entry,
  point?: { x: number; y: number },
): void {
  // 호버 신호는 미리보기와 무관하게 항상 발화(셸 메뉴 예열 구독자용) — 아래 early
  // return 보다 먼저.
  emitHoverEntry(id, entry);
  if (point) {
    const still =
      lastPoint !== null && lastPoint.x === point.x && lastPoint.y === point.y;
    lastPoint = point;
    if (still) return;
  }
  if (!useUI.getState().previewOpen) return;
  if (entry.name === "..") {
    usePreviewHover.getState().set(null);
    return;
  }
  const loc = activeTab(usePanes.getState(), id).location;
  usePreviewHover
    .getState()
    .set({ entry, location: childLocation(loc, entry.name), paneId: id });
}

/** 호버 해제 (리스트 벗어남) → 커서 항목으로 복귀. */
export function clearHover(): void {
  lastPoint = null;
  if (usePreviewHover.getState().target !== null)
    usePreviewHover.getState().set(null);
}

/**
 * 커서가 움직였을 때 — 미리보기 대상만 놓는다. 포인터 위치 기억은 유지해야
 * 스크롤로 포인터 아래를 지나가는 행(mouseenter)을 계속 무시할 수 있다.
 */
export function dropHoverTarget(): void {
  if (usePreviewHover.getState().target !== null)
    usePreviewHover.getState().set(null);
}
