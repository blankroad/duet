import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import { useKeyboardNav } from "./useKeyboardNav";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";
import type { Entry, Location } from "@/types/bindings";
import {
  resetAnchors,
  selectRangeTo,
  setAnchorAt,
} from "@/lib/selectionAnchor";

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
  resetAnchors();
  p.setEntries("left", DIR, ["a", "b", "c", "d", "e", "f"].map(file), {
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

const selected = () => [...tab().selected].sort();
/** Pane 의 클릭 처리와 같은 순서 — 일반 클릭 / Shift 클릭. */
const click = (name: string) => {
  usePanes.getState().clearSelection("left");
  usePanes.getState().setCursor("left", at(name));
  setAnchorAt("left", at(name));
};
const shiftClick = (name: string) => selectRangeTo("left", at(name));

it("keeps the Shift-click anchor at the first click (Explorer/Finder)", () => {
  click("b");
  shiftClick("e");
  shiftClick("c");
  expect(selected()).toEqual(["b", "c"]);
});

it("a plain click resets the anchor used by Shift+arrow", () => {
  fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true }); // b..c
  click("e");
  fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
  expect(selected()).toEqual(["e", "f"]);
});

it("Shift+Left/Right extends the selection in grid view", () => {
  usePanes.getState().setViewMode("left", "grid");
  fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
  fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true });
  expect(selected()).toEqual(["b", "c", "d"]);
});

it("repeating the same letter cycles through matches", () => {
  usePanes
    .getState()
    .setEntries("left", DIR, ["apple", "avocado", "banana"].map(file), {
      pushHistory: false,
    });
  usePanes.getState().setCursor("left", at("banana"));
  fireEvent.keyDown(window, { key: "a" });
  expect(cursorName()).toBe("apple");
  fireEvent.keyDown(window, { key: "a" });
  expect(cursorName()).toBe("avocado");
});
