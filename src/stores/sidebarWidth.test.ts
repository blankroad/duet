import { describe, it, expect, beforeEach } from "vitest";
import {
  clampSidebarWidth,
  useSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
} from "./sidebarWidth";

// localStorage 영속은 try/catch 로 감싼 best-effort (없는 환경도 있다 — 이 테스트
// 러너의 shim 에는 clear() 조차 없다). 그래서 여기선 폭 로직만 검증한다.
describe("sidebarWidth", () => {
  beforeEach(() => useSidebarWidth.getState().reset());

  /** 너무 좁으면 섹션 제목이, 너무 넓으면 패널이 죽는다 — 양쪽을 막는다. */
  it("최소·최대 폭으로 자른다", () => {
    expect(clampSidebarWidth(10)).toBe(150);
    expect(clampSidebarWidth(9999)).toBe(420);
    expect(clampSidebarWidth(240)).toBe(240);
  });

  it("소수점은 반올림", () => {
    expect(clampSidebarWidth(200.6)).toBe(201);
  });

  it("설정한 폭이 store 에 반영되고, 범위를 벗어나면 잘린다", () => {
    useSidebarWidth.getState().setWidth(260);
    expect(useSidebarWidth.getState().width).toBe(260);
    useSidebarWidth.getState().setWidth(5000);
    expect(useSidebarWidth.getState().width).toBe(420);
  });

  it("더블클릭 리셋은 기본값으로", () => {
    useSidebarWidth.getState().setWidth(300);
    useSidebarWidth.getState().reset();
    expect(useSidebarWidth.getState().width).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});
