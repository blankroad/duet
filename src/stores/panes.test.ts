import { describe, it, expect, beforeEach } from "vitest";
import { usePanes, selectDisplayedEntries } from "./panes";
import type { Entry } from "@/types/bindings";

const mk = (name: string, kind: "dir" | "file" = "file", size = 100, mtime = 0, hidden = false): Entry =>
  ({ name, kind, size, modified_ms: mtime, permissions: null, hidden }) as Entry;

describe("panes store sort/hidden", () => {
  beforeEach(() => {
    usePanes.setState((s) => ({
      panes: {
        ...s.panes,
        left: { ...s.panes.left, entries: [], sortKey: "name", sortOrder: "asc", showHidden: false, filter: "", filterFocused: false },
      },
    }));
  });

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
