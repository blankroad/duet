import { afterEach, expect, it } from "vitest";
import { validateEntryName, revealCreatedEntry } from "./newEntry";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
const original = usePanes.getState();
afterEach(() => usePanes.setState(original));
it("rejects traversal and Windows reserved names while allowing remote POSIX names", () => {
  for (const name of [".", "..", " ", "../x", "..\\x", "a\0b"])
    expect(validateEntryName(name, false)).toBe("invalidName");
  for (const name of ["CON.txt", "LPT1", "COM².txt", "name.", "name ", "a:b"])
    expect(validateEntryName(name, true)).toBe("invalidWindowsName");
  expect(validateEntryName("검증 파일.txt", true)).toBeNull();
  expect(validateEntryName("a:b", false)).toBeNull();
});
it("reveals a hidden created item in its original inactive tab without switching tabs", () => {
  const state = usePanes.getState();
  const parent = { source: { kind: "local" as const }, path: "/tmp/create" };
  state.setEntries("left", parent, []);
  state.setFilter("left", "unrelated");
  const id = activeTab(usePanes.getState(), "left").id;
  state.openTab("left", { ...parent, path: "/tmp/other" });
  const activeId = activeTab(usePanes.getState(), "left").id;
  const entry = { name: ".env", kind: "file", hidden: true } as Entry;
  revealCreatedEntry(id, parent, entry.name, [entry]);
  const tab = usePanes.getState().panes.left.tabs.find((t) => t.id === id)!;
  expect(tab.filter).toBe("");
  expect(tab.showHidden).toBe(true);
  expect([...tab.selected]).toEqual([".env"]);
  expect(computeDisplayed(tab)[tab.cursorIndex]?.name).toBe(".env");
  expect(activeTab(usePanes.getState(), "left").id).toBe(activeId);
});
it("does not change a tab that navigated away before creation completed", () => {
  const tab = activeTab(usePanes.getState(), "left");
  revealCreatedEntry(
    tab.id,
    { source: { kind: "local" }, path: "/different" },
    "x",
    [{ name: "x" } as Entry],
  );
  expect(activeTab(usePanes.getState(), "left")).toBe(tab);
});
