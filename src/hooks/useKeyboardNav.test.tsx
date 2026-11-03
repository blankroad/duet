import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { useKeyboardNav } from "./useKeyboardNav";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";
import type { Entry, Location } from "@/types/bindings";

const DIR: Location = { source: { kind: "local" }, path: "/kn" };
const file = (name: string): Entry => ({
  name,
  kind: "file",
  size: 1,
  modified_ms: 0,
  permissions: null,
  hidden: false,
});
const tab = () => activeTab(usePanes.getState(), "left");
const cursorName = () => computeDisplayed(tab())[tab().cursorIndex]?.name;
const at = (name: string) =>
  computeDisplayed(tab()).findIndex((e) => e.name === name);

let quickLook: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const p = usePanes.getState();
  p.closeAllTabs("left");
  p.setActivePane("left");
  p.setViewMode("left", "details");
  p.setEntries("left", DIR, ["a", "b", "c", "d"].map(file), {
    pushHistory: false,
  });
  if (tab().sortKey !== "name") p.toggleSortKey("left", "name");
  if (tab().sortOrder !== "asc") p.toggleSortKey("left", "name");
  p.setCursor("left", at("b"));
  useKeymap.setState({ bindings: [] });
  useCommands.setState({
    builtins: [
      {
        id: "tab.openInNew",
        label: "Open in new tab",
        category: "Tab",
        defaultKey: "Ctrl+Up",
        action: () => {},
      },
    ],
  });
  quickLook = vi.fn();
  renderHook(() => useKeyboardNav(vi.fn(), vi.fn(), quickLook));
});
afterEach(cleanup);

it("leaves command-bound modifier arrows to the command (cursor stays)", () => {
  fireEvent.keyDown(window, { key: "ArrowUp", ctrlKey: true });
  expect(cursorName()).toBe("b");
  fireEvent.keyDown(window, { key: "ArrowUp" });
  expect(cursorName()).toBe("a");
});

it("does not open Quick Look when Space is rebound to another command", () => {
  fireEvent.keyDown(window, { key: " " });
  expect(quickLook).toHaveBeenCalledTimes(1);
  useKeymap.setState({
    bindings: [{ key: "Space", command_id: "tab.openInNew" }],
  });
  fireEvent.keyDown(window, { key: " " });
  expect(quickLook).toHaveBeenCalledTimes(1);
});
