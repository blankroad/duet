import { describe, it, expect, beforeEach } from "vitest";
import { usePanes } from "./panes";

const reset = () => {
  usePanes.setState({
    panes: {
      left: { location: { source: { kind: "local" }, path: "/" }, entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
      right: { location: { source: { kind: "local" }, path: "/" }, entries: [], cursorIndex: -1, selected: new Set(), loadedAt: 0 },
    },
    activePane: "left",
  });
};

const mkEntry = (name: string) => ({
  name,
  kind: "file" as const,
  size: 0,
  modified_ms: null,
  permissions: null,
  hidden: false,
});

describe("panes store", () => {
  beforeEach(reset);

  it("setEntries resets cursor and selection", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/tmp" }, [mkEntry("a"), mkEntry("b")]);
    const p = usePanes.getState().panes.left;
    expect(p.entries).toHaveLength(2);
    expect(p.cursorIndex).toBe(0);
    expect(p.selected.size).toBe(0);
    expect(p.location.path).toBe("/tmp");
  });

  it("moveCursor clamps to range", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mkEntry("a"), mkEntry("b")]);
    usePanes.getState().moveCursor("left", -5);
    expect(usePanes.getState().panes.left.cursorIndex).toBe(0);
    usePanes.getState().moveCursor("left", 100);
    expect(usePanes.getState().panes.left.cursorIndex).toBe(1);
  });

  it("toggleSelected adds and removes", () => {
    usePanes.getState().setEntries("left", { source: { kind: "local" }, path: "/" }, [mkEntry("a")]);
    usePanes.getState().toggleSelected("left", "a");
    expect(usePanes.getState().panes.left.selected.has("a")).toBe(true);
    usePanes.getState().toggleSelected("left", "a");
    expect(usePanes.getState().panes.left.selected.has("a")).toBe(false);
  });
});
