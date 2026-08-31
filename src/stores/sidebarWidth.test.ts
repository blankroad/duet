import { describe, it, expect, beforeEach } from "vitest";
import {
  clampSidebarWidth,
  useSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
} from "./sidebarWidth";

describe("sidebarWidth", () => {
  beforeEach(() => {
    localStorage.clear();
    useSidebarWidth.getState().reset();
  });

  /** 너무 좁으면 섹션 제목이, 너무 넓으면 패널이 죽는다 — 양쪽을 막는다. */
  it("최소·최대 폭으로 자른다", () => {
    expect(clampSidebarWidth(10)).toBe(150);
    expect(clampSidebarWidth(9999)).toBe(420);
    expect(clampSidebarWidth(240)).toBe(240);
  });

  it("소수점은 반올림", () => {
    expect(clampSidebarWidth(200.6)).toBe(201);
  });

  it("설정한 폭을 localStorage 에 남긴다", () => {
    useSidebarWidth.getState().setWidth(260);
    expect(useSidebarWidth.getState().width).toBe(260);
    expect(localStorage.getItem("duet.sidebarWidth.v1")).toBe("260");
  });

  it("더블클릭 리셋은 기본값으로", () => {
    useSidebarWidth.getState().setWidth(300);
    useSidebarWidth.getState().reset();
    expect(useSidebarWidth.getState().width).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});
