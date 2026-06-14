import { describe, it, expect, beforeEach } from "vitest";
import { useContextMenu, isSeparator, type MenuEntry } from "./contextMenu";

describe("contextMenu store", () => {
  beforeEach(() => {
    useContextMenu.setState({ open: false, x: 0, y: 0, items: [] });
  });

  it("openAt sets position, items and open flag", () => {
    const items: MenuEntry[] = [{ id: "a", label: "A" }, { kind: "separator" }];
    useContextMenu.getState().openAt(120, 240, items);
    const s = useContextMenu.getState();
    expect(s.open).toBe(true);
    expect(s.x).toBe(120);
    expect(s.y).toBe(240);
    expect(s.items).toHaveLength(2);
  });

  it("close clears open and items", () => {
    useContextMenu.getState().openAt(1, 2, [{ id: "a", label: "A" }]);
    useContextMenu.getState().close();
    expect(useContextMenu.getState().open).toBe(false);
    expect(useContextMenu.getState().items).toHaveLength(0);
  });

  it("isSeparator distinguishes entries", () => {
    expect(isSeparator({ kind: "separator" })).toBe(true);
    expect(isSeparator({ id: "x", label: "X" })).toBe(false);
  });
});
