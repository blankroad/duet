import { createPanelWidth } from "./panelWidth";

/**
 * 사이드바 폭 — 오른쪽 가장자리를 끌어 조절, 더블클릭으로 기본값.
 * 예전엔 `w-48`(192px) 하드코딩이라 `build-runner-01` 같은 호스트 이름이 잘렸다.
 */
export const SIDEBAR_WIDTH_DEFAULT = 192;

const store = createPanelWidth({
  storageKey: "duet.sidebarWidth.v1",
  defaultWidth: SIDEBAR_WIDTH_DEFAULT,
  min: 150,
  max: 420,
});

export const useSidebarWidth = store.useStore;
export const clampSidebarWidth = store.clamp;
