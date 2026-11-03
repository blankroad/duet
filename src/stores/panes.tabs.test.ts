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

describe("panes — 늦게 도착한 목록은 요청한 탭에만", () => {
  beforeEach(seedFour);
  const tabAt = (i: number) => usePanes.getState().panes.left.tabs[i]!;

  it("요청한 탭이 닫혔으면 응답을 버린다 (남은 탭 경로 불변)", () => {
    usePanes.getState().selectTab("left", 0);
    const reqTab = tabAt(0).id; // /a 에서 /a/child 로 이동 요청
    usePanes.getState().closeOtherTabs("left", 1); // /b 만 남음, 여전히 index 0
    usePanes
      .getState()
      .setEntries("left", loc("/a/child"), [], { tabId: reqTab });
    expect(paths()).toEqual(["/b"]);
  });

  it("요청한 탭이 비활성이 됐어도 그 탭에 적용한다", () => {
    usePanes.getState().selectTab("left", 1);
    const reqTab = tabAt(1).id;
    usePanes.getState().selectTab("left", 3);
    usePanes.getState().setEntries("left", loc("/b/x"), [], { tabId: reqTab });
    expect(paths()).toEqual(["/a", "/b/x", "/c", "/d"]);
    expect(activeIdx()).toBe(3);
  });

  it("setLoading 도 tabId 로 대상 탭을 고른다", () => {
    const reqTab = tabAt(0).id;
    usePanes.getState().setLoading("left", true, reqTab);
    expect(tabAt(0).loading).toBe(true);
    expect(tabAt(3).loading).toBe(false);
  });
});

describe("panes — 새 탭 위치", () => {
  beforeEach(seedFour);

  it("after 를 주면 그 탭 바로 오른쪽에 생기고 활성이 된다", () => {
    usePanes.getState().openTab("left", loc("/a/sub"), { after: 0 });
    expect(paths()).toEqual(["/a", "/a/sub", "/b", "/c", "/d"]);
    expect(activeIdx()).toBe(1);
  });

  it("after 없으면 맨 끝 (Ctrl+T)", () => {
    usePanes.getState().openTab("left");
    expect(paths()).toEqual(["/a", "/b", "/c", "/d", "/d"]);
    expect(activeIdx()).toBe(4);
  });
});

describe("panes — 같은 경로, 다른 소스", () => {
  beforeEach(seedFour);

  it("로컬 /a 에서 원격 /a 로 가면 이동으로 보고 히스토리에 쌓는다", () => {
    usePanes.getState().selectTab("left", 0);
    const remote: Location = {
      source: {
        kind: "ssh",
        connection_id: "prod:u1",
        host_ip: "10.0.0.1",
        user: "me",
      },
      path: "/a",
    };
    usePanes.getState().setEntries("left", remote, []);
    const t = usePanes.getState().panes.left.tabs[0]!;
    expect(t.location.source.kind).toBe("ssh");
    expect(t.history.stack.length).toBe(2);
    expect(t.history.index).toBe(1);
  });
});
