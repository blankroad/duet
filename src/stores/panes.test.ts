import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, activeTab, selectDisplayedEntries } from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: "dir" | "file" = "file", size = 100, mtime = 0, hidden = false): Entry =>
  ({ name, kind, size, modified_ms: mtime, permissions: null, hidden }) as Entry;

const homeLocation = { source: { kind: "local" as const }, path: "/" };

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

describe("panes — tab management", () => {
  beforeEach(reset);

  it("openTab clones current location", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/foo" }, []);
    usePanes.getState().openTab("left");
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
    expect(p.tabs[1]!.location.path).toBe("/foo");
  });

  it("openTab with explicit location", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/bar" });
    const p = usePanes.getState().panes.left;
    expect(p.tabs[1]!.location.path).toBe("/bar");
    expect(p.activeTabIndex).toBe(1);
  });

  it("closeTab last tab is no-op", () => {
    usePanes.getState().closeTab("left", 0);
    expect(usePanes.getState().panes.left.tabs.length).toBe(1);
  });

  it("closeTab non-active shifts active down", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/b" });
    usePanes.getState().closeTab("left", 0);
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
  });

  it("closeTab active selects left", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/b" });
    usePanes.getState().closeTab("left", 2);
    const p = usePanes.getState().panes.left;
    expect(p.tabs.length).toBe(2);
    expect(p.activeTabIndex).toBe(1);
    expect(p.tabs[1]!.location.path).toBe("/a");
  });

  it("selectTab changes activeTabIndex", () => {
    usePanes.getState().openTab("left", { source: { kind: "local" }, path: "/a" });
    usePanes.getState().selectTab("left", 0);
    expect(usePanes.getState().panes.left.activeTabIndex).toBe(0);
  });
});

describe("panes — sort/hidden via active tab", () => {
  beforeEach(reset);

  it("sort by name asc — dirs first", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk("zeta", "file"),
      mk("alpha", "dir"),
      mk("beta", "file"),
      mk("gamma", "dir"),
    ]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["alpha", "gamma", "beta", "zeta"]);
  });

  it("sort by size desc", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
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
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk(".bashrc", "file", 100, 0, true),
      mk("README.md", "file"),
    ]);
    usePanes.getState().toggleShowHidden("left");
    expect(selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name)).toEqual([
      ".bashrc",
      "README.md",
    ]);
  });
});

describe("panes — '..' parent row", () => {
  beforeEach(reset);

  it("prepends '..' at non-root, not at root", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/foo" }, [mk("a"), mk("b")]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["..", "a", "b"]);

    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a")]);
    expect(selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name)).toEqual(["a"]);
  });

  it("'..' stays first even when sorted desc", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/foo" }, [mk("a"), mk("z")]);
    usePanes.getState().setSort("left", "name", "desc");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["..", "z", "a"]);
  });

  it("no '..' while filtering", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/foo" }, [mk("apple"), mk("banana")]);
    usePanes.getState().setFilter("left", "an");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["banana"]);
  });

  it("shows '..' in an empty non-root folder", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/foo" }, []);
    expect(selectDisplayedEntries("left", usePanes.getState()).map((e) => e.name)).toEqual([".."]);
  });
});

describe("panes — cursor & selection (legacy)", () => {
  beforeEach(reset);

  it("setEntries resets cursor", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a"), mk("b")]);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(0);
  });

  it("moveCursor clamps", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a"), mk("b")]);
    usePanes.getState().moveCursor("left", 5);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(1);
    usePanes.getState().moveCursor("left", -10);
    expect(activeTab(usePanes.getState(), "left").cursorIndex).toBe(0);
  });

  it("toggleSelected adds and removes", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("x")]);
    usePanes.getState().toggleSelected("left", "x");
    expect(activeTab(usePanes.getState(), "left").selected.has("x")).toBe(true);
    usePanes.getState().toggleSelected("left", "x");
    expect(activeTab(usePanes.getState(), "left").selected.has("x")).toBe(false);
  });
});

describe("panes — history", () => {
  beforeEach(reset);

  it("setEntries pushes history on path change", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a", "/b"]);
    expect(t.history.index).toBe(2);
  });

  it("setEntries same path does not push", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.length).toBe(2);
  });

  it("setEntries pushHistory=false skips", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, [], { pushHistory: false });
    const t = activeTab(usePanes.getState(), "left");
    expect(t.history.stack.map((l) => l.path)).toEqual(["/", "/a"]);
  });

  it("back returns previous location", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    const prev = usePanes.getState().back("left");
    expect(prev?.path).toBe("/a");
    expect(activeTab(usePanes.getState(), "left").history.index).toBe(1);
  });

  it("back at index 0 returns null", () => {
    expect(usePanes.getState().back("left")).toBeNull();
  });

  it("forward after back", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    usePanes.getState().back("left");
    const next = usePanes.getState().forward("left");
    expect(next?.path).toBe("/b");
  });

  it("navigate after back truncates forward stack", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/a" }, []);
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/b" }, []);
    usePanes.getState().back("left");
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/c" }, []);
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
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(new Set(["a", "b", "c"]));
    usePanes.getState().setSelected("left", ["x"]);
    expect(activeTab(usePanes.getState(), "left").selected).toEqual(new Set(["x"]));
  });

  it("empty array clears selection", () => {
    usePanes.getState().setSelected("left", ["a"]);
    usePanes.getState().setSelected("left", []);
    expect(activeTab(usePanes.getState(), "left").selected.size).toBe(0);
  });
});
