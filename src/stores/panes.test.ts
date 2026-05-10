import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, selectDisplayedEntries } from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: "dir" | "file" = "file", size = 100, mtime = 0, hidden = false): Entry =>
  ({ name, kind, size, modified_ms: mtime, permissions: null, hidden }) as Entry;

const resetLeft = () => {
  usePanes.setState((s) => ({
    panes: {
      ...s.panes,
      left: { ...s.panes.left, entries: [], cursorIndex: -1, selected: new Set(), sortKey: "name", sortOrder: "asc", showHidden: false, filter: "", filterFocused: false, loadedAt: 0 },
    },
  }));
};

describe("panes store — cursor & selection", () => {
  beforeEach(resetLeft);

  it("setEntries resets cursor and selection", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/tmp" }, [mk("a"), mk("b")]);
    const p = usePanes.getState().panes.left;
    expect(p.entries).toHaveLength(2);
    expect(p.cursorIndex).toBe(0);
    expect(p.selected.size).toBe(0);
    expect(p.location.path).toBe("/tmp");
  });

  it("moveCursor clamps to range", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a"), mk("b")]);
    usePanes.getState().moveCursor("left", -5);
    expect(usePanes.getState().panes.left.cursorIndex).toBe(0);
    usePanes.getState().moveCursor("left", 100);
    expect(usePanes.getState().panes.left.cursorIndex).toBe(1);
  });

  it("toggleSelected adds and removes", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mk("a")]);
    usePanes.getState().toggleSelected("left", "a");
    expect(usePanes.getState().panes.left.selected.has("a")).toBe(true);
    usePanes.getState().toggleSelected("left", "a");
    expect(usePanes.getState().panes.left.selected.has("a")).toBe(false);
  });
});

describe("panes store sort/hidden", () => {
  beforeEach(resetLeft);

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

  it("toggleSortKey: 같은 key — order toggle", () => {
    usePanes.getState().setSort("left", "name", "asc");
    usePanes.getState().toggleSortKey("left", "name");
    expect(usePanes.getState().panes.left.sortOrder).toBe("desc");
    usePanes.getState().toggleSortKey("left", "name");
    expect(usePanes.getState().panes.left.sortOrder).toBe("asc");
  });

  it("toggleSortKey: 다른 key — 새 key + asc", () => {
    usePanes.getState().setSort("left", "name", "desc");
    usePanes.getState().toggleSortKey("left", "size");
    expect(usePanes.getState().panes.left.sortKey).toBe("size");
    expect(usePanes.getState().panes.left.sortOrder).toBe("asc");
  });

  it("hidden default — dotfiles 숨김", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk(".bashrc", "file", 100, 0, true),
      mk("README.md", "file"),
    ]);
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual(["README.md"]);
  });

  it("toggleShowHidden — dotfiles 표시", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [
      mk(".bashrc", "file", 100, 0, true),
      mk("README.md", "file"),
    ]);
    usePanes.getState().toggleShowHidden("left");
    const out = selectDisplayedEntries("left", usePanes.getState());
    expect(out.map((e) => e.name)).toEqual([".bashrc", "README.md"]);
  });
});
