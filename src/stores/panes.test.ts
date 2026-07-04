import { describe, it, expect, beforeEach } from "vitest";
import {
  usePanes,
  activeTab,
  selectDisplayedEntries,
  computeDisplayed,
  isRootPath,
  type TabState,
} from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (
  name: string,
  kind: "dir" | "file" = "file",
  size = 100,
  mtime = 0,
  hidden = false,
): Entry =>
  ({
    name,
    kind,
    size,
    modified_ms: mtime,
    permissions: null,
    hidden,
  }) as Entry;

const homeLocation = { source: { kind: "local" as const }, path: "/" };

const mkTab = (path: string, entries: Entry[] = []): TabState => ({
  id: "t",
  location: { source: { kind: "local" }, path },
  entries,
  cursorIndex: -1,
  selected: new Set<string>(),
  loadedAt: 0,
  sortKey: "name",
  sortOrder: "asc",
  showHidden: false,
  viewMode: "details",
  gridCols: 1,
  loading: false,
  filter: "",
  filterFocused: false,
  dirSizes: {},
  history: { stack: [], index: 0 },
});

describe("root parent entry (..)", () => {
  it("isRootPath: unix + windows 드라이브 루트", () => {
    expect(isRootPath("/")).toBe(true);
    expect(isRootPath("")).toBe(true);
    expect(isRootPath("C:\\")).toBe(true);
    expect(isRootPath("C:/")).toBe(true);
    expect(isRootPath("C:")).toBe(true);
    expect(isRootPath("/home/u")).toBe(false);
    expect(isRootPath("C:\\Users")).toBe(false);
    expect(isRootPath("C:\\Users\\")).toBe(false);
  });

  it("드라이브 루트엔 '..' 없음, 하위폴더엔 있음", () => {
    expect(
      computeDisplayed(mkTab("C:\\", [mk("a.txt")])).some(
        (e) => e.name === "..",
      ),
    ).toBe(false);
    expect(
      computeDisplayed(mkTab("/", [mk("a.txt")])).some((e) => e.name === ".."),
    ).toBe(false);
    expect(computeDisplayed(mkTab("C:\\Users", [mk("a.txt")]))[0]?.name).toBe(
      "..",
    );
    expect(computeDisplayed(mkTab("/home/u", [mk("a.txt")]))[0]?.name).toBe(
      "..",
    );
  });
});

const reset = () => {
  usePanes.setState((s) => {
    const fresh = (id: "left" | "right") => ({
      tabs: [
        {
          ...s.panes[id].tabs[0]!,
          location: homeLocation,
          entries: [],
          cursorIndex: -1,
          selected: new Set<string>(),
          sortKey: "name" as const,
          sortOrder: "asc" as const,
          showHidden: false,
          viewMode: "details" as const,
          gridCols: 1,
          filter: "",
          filterFocused: false,
          dirSizes: {},
          history: { stack: [homeLocation], index: 0 },
        },
      ],
      activeTabIndex: 0,
    });
    return {
      panes: { left: fresh("left"), right: fresh("right") },
      activePane: "left" as const,
    };
  });
};

describe("panes — dirSizes (크기 계산 캐시)", () => {
  beforeEach(reset);

  it("setDirSize 는 tabId 로 대상 탭에 기록 — 활성 탭이 바뀌어도 안전", () => {
    const s = usePanes.getState();
    const tabId = s.panes.left.tabs[0]!.id;
    s.setDirSize("left", tabId, "docs", 1234);
    expect(usePanes.getState().panes.left.tabs[0]!.dirSizes["docs"]).toBe(1234);
    // 없는 tabId 는 무시(탭 닫힘 후 늦게 도착한 결과).
    s.setDirSize("left", "gone", "x", 1);
    expect(usePanes.getState().panes.left.tabs[0]!.dirSizes["x"]).toBeUndefined();
  });

  it("같은 폴더 새로고침은 유지, 다른 폴더 이동은 리셋", () => {
    const s = usePanes.getState();
    const tabId = s.panes.left.tabs[0]!.id;
    s.setDirSize("left", tabId, "docs", 55);
    // 같은 경로 reload
    s.setEntries("left", homeLocation, [mk("docs", "dir")]);
    expect(usePanes.getState().panes.left.tabs[0]!.dirSizes["docs"]).toBe(55);
    // 다른 경로 navigate
    s.setEntries("left", { source: { kind: "local" }, path: "/tmp2" }, []);
    expect(usePanes.getState().panes.left.tabs[0]!.dirSizes).toEqual({});
  });
});

describe("panes — tab management", () => {
  beforeEach(reset);

  it("openTab clones current location", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/foo" }, []);
    usePanes.getState().openTab("left");
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
    expect(p.tabs[1]!.location.path).toBe("/foo");
  });

  it("openTab with explicit location", () => {
    usePanes
      .getState()
      .openTab("left", { source: { kind: "local" }, path: "/bar" });
    const p = usePanes.getState().panes.left;
    expect(p.tabs[1]!.location.path).toBe("/bar");
    expect(p.activeTabIndex).toBe(1);
  });

  it("closeTab last tab is no-op", () => {
    usePanes.getState().closeTab("left", 0);
    expect(usePanes.getState().panes.left.tabs.length).toBe(1);
  });

  it("closeTab non-active shifts active down", () => {
    usePanes
      .getState()
      .openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes
      .getState()
      .openTab("left", { source: { kind: "local" }, path: "/b" });
    usePanes.getState().closeTab("left", 0);
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
  });

  it("closeTab active selects left", () => {
    usePanes
      .getState()
      .openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes
      .getState()
      .openTab("left", { source: { kind: "local" }, path: "/b" });
    usePanes.getState().closeTab("left", 2);
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
    expect(p.tabs[1]!.location.path).toBe("/a");
  });

  it("selectTab changes activeTabIndex", () => {
    usePanes
      .getState()
      .openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().selectTab("left", 0);
    expect(usePanes.getState().panes.left.activeTabIndex).toBe(0);
  });
});

describe("panes — sort/hidden via active tab", () => {
  beforeEach(reset);

  it("sort by name asc — dirs first", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [
        mk("zeta", "file"),
        mk("alpha", "dir"),
        mk("beta", "file"),
        mk("gamma", "dir"),
      ]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["alpha", "gamma", "beta", "zeta"]);
  });

  it("sort by size desc", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [
        mk("a", "file", 100),
        mk("b", "file", 300),
        mk("c", "file", 200),
      ]);
    usePanes.getState().setSort("left", "size", "desc");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["b", "c", "a"]);
  });

  it("toggleSortKey same key flips order", () => {
    usePanes.getState().setSort("left", "name", "asc");
    usePanes.getState().toggleSortKey("left", "name");
    expect(activeTab(usePanes.getState(), "left").sortOrder).toBe("desc");
  });

  it("toggleShowHidden shows dotfiles", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [
        mk(".bashrc", "file", 100, 0, true),
        mk("README.md", "file"),
      ]);
    usePanes.getState().toggleShowHidden("left");
    expect(
      selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name),
    ).toEqual([".bashrc", "README.md"]);
  });
});

describe("panes — '..' parent row", () => {
  beforeEach(reset);

  it("prepends '..' at non-root, not at root", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/foo" }, [
        mk("a"),
        mk("b"),
      ]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["..", "a", "b"]);

    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a")]);
    expect(
      selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name),
    ).toEqual(["a"]);
  });

  it("'..' stays first even when sorted desc", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/foo" }, [
        mk("a"),
        mk("z"),
      ]);
    usePanes.getState().setSort("left", "name", "desc");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["..", "z", "a"]);
  });

  it("no '..' while filtering", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/foo" }, [
        mk("apple"),
        mk("banana"),
      ]);
    usePanes.getState().setFilter("left", "an");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["banana"]);
  });

  it("shows '..' in an empty non-root folder", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/foo" }, []);
    expect(
      selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name),
    ).toEqual([".."]);
  });
});

describe("panes — loading flag", () => {
  beforeEach(reset);

  it("setLoading sets, setEntries clears", () => {
    usePanes.getState().setLoading("left", true);
    expect(activeTab(usePanes.getState(), "left").loading).toBe(true);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    expect(activeTab(usePanes.getState(), "left").loading).toBe(false);
  });
});

describe("panes — cursor & selection (legacy)", () => {
  beforeEach(reset);

  it("setEntries resets cursor", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [
        mk("a"),
        mk("b"),
      ]);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(0);
  });

  it("moveCursor clamps", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [
        mk("a"),
        mk("b"),
      ]);
    usePanes.getState().moveCursor("left", 5);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(1);
    usePanes.getState().moveCursor("left", -10);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(0);
  });

  it("toggleSelected adds and removes", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("x")]);
    usePanes.getState().toggleSelected("left", "x");
    expect(activeTab(usePanes.getState(), "left").selected.has("x")).toBe(true);
    usePanes.getState().toggleSelected("left", "x");
    expect(activeTab(usePanes.getState(), "left").selected.has("x")).toBe(
      false,
    );
  });
});

describe("panes — history", () => {
  beforeEach(reset);

  it("setEntries pushes history on path change", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a", "/b"]);
    expect(t.history.index).toBe(2);
  });

  it("setEntries same path does not push", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.length).toBe(2);
  });

  it("setEntries pushHistory=false skips", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/b" }, [], {
        pushHistory: false,
      });
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a"]);
  });

  it("back returns previous location", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    const prev = usePanes.getState().back("left");
    expect(prev?.path).toBe("/a");
    expect(activeTab(usePanes.getState(), "left").history.index).toBe(1);
  });

  it("back at index 0 returns null", () => {
    expect(usePanes.getState().back("left")).toBeNull();
  });

  it("forward after back", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    usePanes.getState().back("left");
    const next = usePanes.getState().forward("left");
    expect(next?.path).toBe("/b");
  });

  it("navigate after back truncates forward stack", () => {
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    usePanes.getState().back("left");
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/c" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a", "/c"]);
    expect(t.history.index).toBe(2);
  });
});

describe("panes — view mode", () => {
  beforeEach(reset);

  it("defaults to details", () => {
    expect(activeTab(usePanes.getState(), "left").viewMode).toBe("details");
  });

  it("setViewMode switches the active tab's view", () => {
    usePanes.getState().setViewMode("left", "grid");
    expect(activeTab(usePanes.getState(), "left").viewMode).toBe("grid");
  });

  it("cycleViewMode rotates details → grid → tiles → details", () => {
    const cycle = () => usePanes.getState().cycleViewMode("left");
    cycle();
    expect(activeTab(usePanes.getState(), "left").viewMode).toBe("grid");
    cycle();
    expect(activeTab(usePanes.getState(), "left").viewMode).toBe("tiles");
    cycle();
    expect(activeTab(usePanes.getState(), "left").viewMode).toBe("details");
  });

  it("setGridCols clamps to >= 1", () => {
    usePanes.getState().setGridCols("left", 0);
    expect(activeTab(usePanes.getState(), "left").gridCols).toBe(1);
    usePanes.getState().setGridCols("left", 5);
    expect(activeTab(usePanes.getState(), "left").gridCols).toBe(5);
  });
});

describe("panes — setSelected", () => {
  beforeEach(reset);

  it("replaces the selection set", () => {
    usePanes.getState().setSelected("left", ["a", "b", "c"]);
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(
      new Set(["a", "b", "c"]),
    );
    usePanes.getState().setSelected("left", ["x"]);
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(
      new Set(["x"]),
    );
  });

  it("empty array clears selection", () => {
    usePanes.getState().setSelected("left", ["a"]);
    usePanes.getState().setSelected("left", []);
    expect(activeTab(usePanes.getState(), "left").selected.size).toBe(0);
  });
});

describe("panes — selectByPattern (glob-select)", () => {
  beforeEach(reset);

  const seed = () =>
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/proj" }, [
        mk("a.ts"),
        mk("b.ts"),
        mk("c.tsx"),
        mk("readme.md"),
        mk("src", "dir"),
      ]);

  it("add mode selects glob matches, excludes '..'", () => {
    seed();
    const n = usePanes.getState().selectByPattern("left", "*.ts", "add");
    const sel = activeTab(usePanes.getState(), "left").selected;
    expect(sel).toEqual(new Set(["a.ts", "b.ts"]));
    expect(sel.has("..")).toBe(false);
    expect(n).toBe(2); // 매치 수 반환
  });

  it("returns 0 and changes nothing when no match", () => {
    seed();
    const n = usePanes.getState().selectByPattern("left", "*.zip", "add");
    expect(n).toBe(0);
    expect(activeTab(usePanes.getState(), "left").selected.size).toBe(0);
  });

  it("moves cursor to first match (brings it into view) on add", () => {
    seed(); // dirs-first 정렬: [.., src, a.ts, b.ts, c.tsx, readme.md]
    usePanes.getState().selectByPattern("left", "readme*", "add");
    const t = activeTab(usePanes.getState(), "left");
    const disp = selectDisplayedEntries("left", usePanes.getState());
    expect(disp[t.cursorIndex]?.name).toBe("readme.md");
  });

  it("remove mode unselects matches, leaves the rest", () => {
    seed();
    usePanes.getState().setSelected("left", ["a.ts", "b.ts", "readme.md"]);
    usePanes.getState().selectByPattern("left", "*.ts", "remove");
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(
      new Set(["readme.md"]),
    );
  });

  it("substring pattern (no glob meta) matches by inclusion", () => {
    seed();
    usePanes.getState().selectByPattern("left", "re", "add");
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(
      new Set(["readme.md"]),
    );
  });

  it("only targets displayed entries (respects active filter)", () => {
    seed();
    usePanes.getState().setFilter("left", "b"); // displays only b.ts
    usePanes.getState().selectByPattern("left", "*.ts", "add");
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(
      new Set(["b.ts"]),
    );
  });
});

describe("panes — swap / move tab", () => {
  beforeEach(reset);

  it("swapPanes exchanges left/right content, keeps focus side", () => {
    const st = usePanes.getState();
    st.setEntries("left", { source: { kind: "local" }, path: "/foo" }, []);
    st.setEntries("right", { source: { kind: "local" }, path: "/bar" }, []);
    st.setActivePane("left");
    usePanes.getState().swapPanes();
    const s = usePanes.getState();
    expect(activeTab(s, "left").location.path).toBe("/bar");
    expect(activeTab(s, "right").location.path).toBe("/foo");
    expect(s.activePane).toBe("left"); // 포커스 위치 유지
  });

  it("moveActiveTabToOther moves the active tab and follows focus", () => {
    const st = usePanes.getState();
    st.setActivePane("left");
    st.setEntries("left", { source: { kind: "local" }, path: "/from" }, []);
    st.openTab("left", { source: { kind: "local" }, path: "/extra" }); // left 2 tabs, active=extra
    usePanes.getState().moveActiveTabToOther();
    const s = usePanes.getState();
    expect(s.activePane).toBe("right");
    expect(activeTab(s, "right").location.path).toBe("/extra"); // 이동됨
    expect(s.panes.left.tabs.length).toBe(1); // 소스에서 제거
  });

  it("moving the only tab leaves a fresh tab (no empty split)", () => {
    const st = usePanes.getState();
    st.setActivePane("left");
    st.setEntries("left", { source: { kind: "local" }, path: "/solo" }, []);
    usePanes.getState().moveActiveTabToOther();
    const s = usePanes.getState();
    expect(s.panes.left.tabs.length).toBe(1); // fresh tab
    expect(activeTab(s, "right").location.path).toBe("/solo");
  });
});
