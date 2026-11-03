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
        tabs: [{ ...cur, location: loc("/a"), pinned: false }],
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

describe("panes — 핀 탭", () => {
  beforeEach(seedFour);
  const pins = () => usePanes.getState().panes.left.tabs.map((t) => t.pinned);
  const activePath = () =>
    String(usePanes.getState().panes.left.tabs[activeIdx()]!.location.path);

  it("핀하면 핀 구간 끝으로 가고 활성 탭은 그대로", () => {
    usePanes.getState().togglePinTab("left", 2); // /c
    expect(paths()).toEqual(["/c", "/a", "/b", "/d"]);
    expect(pins()).toEqual([true, false, false, false]);
    expect(activePath()).toBe("/d");
    usePanes.getState().togglePinTab("left", 3); // /d
    expect(paths()).toEqual(["/c", "/d", "/a", "/b"]);
    expect(activePath()).toBe("/d");
  });

  it("해제하면 일반 구간 맨 앞으로", () => {
    usePanes.getState().togglePinTab("left", 2); // [c*, a, b, d]
    usePanes.getState().togglePinTab("left", 3); // [c*, d*, a, b]
    usePanes.getState().togglePinTab("left", 0); // c 해제 → [d*, c, a, b]
    expect(paths()).toEqual(["/d", "/c", "/a", "/b"]);
    expect(pins()).toEqual([true, false, false, false]);
  });

  it("핀 탭은 closeTab 으로 닫히지 않는다 (X·가운데 클릭·Ctrl+W 공통)", () => {
    usePanes.getState().togglePinTab("left", 0);
    expect(usePanes.getState().closeTab("left", 0)).toBe(false);
    expect(paths()).toEqual(["/a", "/b", "/c", "/d"]);
    expect(usePanes.getState().closeTab("left", 1)).toBe(true);
    expect(paths()).toEqual(["/a", "/c", "/d"]);
  });

  it("다른 탭 모두 닫기 — 지목한 탭과 핀이 남고 지목한 탭이 활성", () => {
    usePanes.getState().togglePinTab("left", 0); // a*
    usePanes.getState().closeOtherTabs("left", 2); // /c
    expect(paths()).toEqual(["/a", "/c"]);
    expect(activePath()).toBe("/c");
  });

  it("오른쪽 탭 모두 닫기 — 핀은 오른쪽이어도 남는다", () => {
    usePanes.getState().togglePinTab("left", 1); // [b*, a, c, d]
    usePanes.getState().closeTabsToRight("left", 0); // b 오른쪽 일반 탭 전부
    expect(paths()).toEqual(["/b"]);
    expect(activePath()).toBe("/b");
  });

  it("모두 닫기 — 핀이 있으면 핀만 남고 마지막 핀이 활성", () => {
    usePanes.getState().togglePinTab("left", 0); // a*
    usePanes.getState().togglePinTab("left", 1); // b*
    usePanes.getState().closeAllTabs("left"); // 활성 /d 는 일반 탭
    expect(paths()).toEqual(["/a", "/b"]);
    expect(activePath()).toBe("/b");
  });

  it("모두 닫기 — 활성이 핀이면 그 핀이 활성으로 남는다", () => {
    usePanes.getState().togglePinTab("left", 0);
    usePanes.getState().togglePinTab("left", 1);
    usePanes.getState().selectTab("left", 0);
    usePanes.getState().closeAllTabs("left");
    expect(paths()).toEqual(["/a", "/b"]);
    expect(activePath()).toBe("/a");
  });

  it("새 탭은 핀 구간 안에 들어가지 않는다", () => {
    usePanes.getState().togglePinTab("left", 0);
    usePanes.getState().togglePinTab("left", 1); // [a*, b*, c, d]
    usePanes.getState().openTab("left", loc("/x"), { after: 0 });
    expect(paths()).toEqual(["/a", "/b", "/x", "/c", "/d"]);
    expect(pins()).toEqual([true, true, false, false, false]);
  });

  it("핀 탭을 반대 패널로 옮기면 그쪽 핀 구간 끝에 핀인 채로 들어간다", () => {
    usePanes.getState().togglePinTab("left", 0); // a* 활성 아님
    usePanes.getState().selectTab("left", 0);
    usePanes.getState().setActivePane("left");
    const right = () => usePanes.getState().panes.right;
    const before = right().tabs.length;
    usePanes.getState().moveActiveTabToOther();
    expect(right().tabs.length).toBe(before + 1);
    expect(right().tabs[0]!.pinned).toBe(true);
    expect(String(right().tabs[0]!.location.path)).toBe("/a");
    expect(right().activeTabIndex).toBe(0);
    // 원상복구 — 다른 테스트가 오른쪽 패널을 쓰지 않도록.
    usePanes.getState().moveActiveTabToOther();
  });
});

describe("panes — 탭 복제", () => {
  beforeEach(seedFour);

  it("원본 바로 오른쪽에 정렬·보기·히스토리를 그대로 복제하고 활성화", () => {
    usePanes.getState().selectTab("left", 1);
    usePanes.getState().setSort("left", "size", "asc");
    usePanes.getState().setViewMode("left", "grid");
    usePanes.getState().setEntries("left", loc("/b/x"), []);
    usePanes.getState().duplicateTab("left", 1);
    const left = usePanes.getState().panes.left;
    expect(paths()).toEqual(["/a", "/b/x", "/b/x", "/c", "/d"]);
    expect(left.activeTabIndex).toBe(2);
    const dup = left.tabs[2]!;
    expect(dup.id).not.toBe(left.tabs[1]!.id);
    expect(dup.sortKey).toBe("size");
    expect(dup.viewMode).toBe("grid");
    expect(dup.history.stack.map((l) => String(l.path))).toEqual([
      "/b",
      "/b/x",
    ]);
  });

  it("핀 탭을 복제하면 일반 탭으로 핀 구간 바로 뒤에", () => {
    usePanes.getState().togglePinTab("left", 0);
    usePanes.getState().togglePinTab("left", 1); // [a*, b*, c, d]
    usePanes.getState().duplicateTab("left", 0);
    expect(paths()).toEqual(["/a", "/b", "/a", "/c", "/d"]);
    expect(usePanes.getState().panes.left.tabs[2]!.pinned).toBe(false);
  });

  it("아카이브 안에서 새 탭(Ctrl+T)은 아카이브 문맥을 가져간다", () => {
    const ctx = { label: "x.zip", root: "/tmp/x", exitTo: loc("/d") };
    usePanes.getState().setArchiveContext("left", ctx);
    usePanes.getState().openTab("left");
    const left = usePanes.getState().panes.left;
    expect(left.tabs[left.activeTabIndex]!.archive).toEqual(ctx);
  });
});
