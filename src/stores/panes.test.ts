import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, activeTab, selectDisplayedEntries } from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: "dir" | "file" = "file", size = 100, mtime = 0, hidden = false): Entry =>
  ({ name, kind, size, modified_ms: mtime, permissions: null, hidden }) as Entry;

const reset = () => {
  usePanes.setState((s) => {
    const fresh = (id: "left" | "right") => ({
      tabs: [
        {
          ...s.panes[id].tabs[0]!,
          entries: [],
          cursorIndex: -1,
          selected: new Set<string>(),
          sortKey: "name" as const,
          sortOrder: "asc" as const,
          showHidden: false,
          filter: "",
          filterFocused: false,
          history: { stack: [s.panes[id].tabs[0]!.location], index: 0 },
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
