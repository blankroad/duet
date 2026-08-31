import { createPanelWidth } from "./panelWidth";

/**
 * 미리보기(정보) 패널 폭 — 왼쪽 가장자리를 끌어 조절, 더블클릭으로 기본값.
 *
 * 기본값을 320 → 260 으로 줄였다: 이 앱의 주인공은 듀얼 패널 탐색기고 정보 패널은
 * 보조라, 기본 상태에서 파일 목록을 덜 먹는 쪽이 맞다 (2026-08 사용자 피드백).
 */
export const PREVIEW_WIDTH_DEFAULT = 260;

const store = createPanelWidth({
  storageKey: "duet.previewWidth.v1",
  defaultWidth: PREVIEW_WIDTH_DEFAULT,
  min: 200,
  max: 560,
});

export const usePreviewWidth = store.useStore;
export const clampPreviewWidth = store.clamp;
