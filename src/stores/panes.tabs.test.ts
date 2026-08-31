import { describe, it, expect, beforeEach } from "vitest";
import { usePanes } from "./panes";
import type { Location } from "@/types/bindings";

const loc = (path: string): Location => ({ source: { kind: "local" }, path });
const paths = () =>
  usePanes.getState().panes.left.tabs.map((t) => String(t.location.path));
const activeIdx = () => usePanes.getState().panes.left.activeTabIndex;

/** left 패널에 /a /b /c /d 네 탭을 만든다 (첫 탭은 초기 탭을 /a 로 덮어씀). */
function seedFour() {
  const s = usePanes.getState();
  // 기존 탭을 하나로 줄이고 시작.
  s.closeAllTabs("left");
  const cur = usePanes.getState().panes.left.tabs[0]!;
  usePanes.setState((st) => ({
    panes: {
      ...st.panes,
      left: {
        tabs: [{ ...cur, location: loc("/a") }],
        activeTabIndex: 0,
      },
    },
  }));
  for (const p of ["/b", "/c", "/d"])
    usePanes.getState().openTab("left", loc(p));
}

describe("panes — 탭 닫기", () => {
  beforeEach(seedFour);

  it("준비: 네 탭, 마지막이 활성", () => {
    expect(paths()).toEqual(["/a", "/b", "/c", "/d"]);
    expect(activeIdx()).toBe(3);
  });

  it("다른 탭 모두 닫기 — 지목한 탭만 남는다", () => {
    usePanes.getState().closeOtherTabs("left", 1);
    expect(paths()).toEqual(["/b"]);
    expect(activeIdx()).toBe(0);
  });

  it("오른쪽 탭 모두 닫기 — 지목한 탭까지 남는다", () => {
    usePanes.getState().closeTabsToRight("left", 1);
    expect(paths()).toEqual(["/a", "/b"]);
  });

  /** 활성 탭이 닫히는 범위에 있었으면 기준 탭으로 옮겨와야 한다 (인덱스 초과 방지). */
  it("오른쪽 닫기로 활성 탭이 사라지면 기준 탭이 활성", () => {
    usePanes.getState().closeTabsToRight("left", 1);
    expect(activeIdx()).toBe(1);
  });

  it("맨 오른쪽 탭에서 '오른쪽 닫기'는 아무 일도 하지 않는다", () => {
    usePanes.getState().closeTabsToRight("left", 3);
    expect(paths()).toEqual(["/a", "/b", "/c", "/d"]);
  });

  /**
   * "모두 닫기"는 어느 탭에서 눌러도 **활성 탭**을 남긴다 — 패널은 탭이 최소 1개
   * 필요하므로. 그래서 비활성 탭에서 누르면 "다른 탭 모두 닫기"와 결과가 다르다.
   */
  it("모두 닫기 — 누른 탭과 무관하게 활성 탭만 남는다", () => {
    usePanes.getState().selectTab("left", 2);
    usePanes.getState().closeAllTabs("left");
    expect(paths()).toEqual(["/c"]);
    expect(activeIdx()).toBe(0);
  });

  it("탭이 하나면 닫기 계열은 모두 no-op", () => {
    // 0번(/a)만 남긴 뒤 — 마지막 한 장은 어떤 닫기로도 사라지지 않아야 한다.
    usePanes.getState().closeOtherTabs("left", 0);
    expect(paths()).toEqual(["/a"]);
    usePanes.getState().closeAllTabs("left");
    usePanes.getState().closeOtherTabs("left", 0);
    usePanes.getState().closeTabsToRight("left", 0);
    usePanes.getState().closeTab("left", 0);
    expect(paths()).toEqual(["/a"]);
    expect(activeIdx()).toBe(0);
  });
});
