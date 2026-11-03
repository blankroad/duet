import { beforeEach, expect, it } from "vitest";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import type { Entry, Location } from "@/types/bindings";
import { followRenamedEntry } from "./renameReveal";

const DIR: Location = { source: { kind: "local" }, path: "/w" };
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

beforeEach(() => {
  usePanes.getState().closeAllTabs("left");
  usePanes
    .getState()
    .setEntries("left", DIR, ["a.txt", "b.txt", "c.txt"].map(file), {
      pushHistory: false,
    });
});

it("keeps cursor and selection on the renamed item after a refresh", () => {
  const p = usePanes.getState();
  const idx = computeDisplayed(tab()).findIndex((e) => e.name === "a.txt");
  p.setCursor("left", idx);
  p.setSelected("left", ["a.txt"]);
  followRenamedEntry("left", DIR, "a.txt", "z.txt");
  expect(cursorName()).toBe("z.txt");
  expect([...tab().selected]).toEqual(["z.txt"]);
  // 백엔드 새로고침 결과(새 이름 포함)가 와도 커서는 새 이름을 지킨다.
  p.setEntries("left", DIR, ["b.txt", "c.txt", "z.txt"].map(file), {
    pushHistory: false,
  });
  expect(cursorName()).toBe("z.txt");
});

it("does nothing when the pane has moved to another folder", () => {
  const before = tab();
  followRenamedEntry(
    "left",
    { source: { kind: "local" }, path: "/elsewhere" },
    "a.txt",
    "z.txt",
  );
  expect(tab()).toBe(before);
});
