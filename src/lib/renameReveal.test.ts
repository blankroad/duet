import { beforeEach, expect, it, vi } from "vitest";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import type { Entry, Location } from "@/types/bindings";
import { followRenamedEntry } from "./renameReveal";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

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
const at = (name: string) =>
  computeDisplayed(tab()).findIndex((e) => e.name === name);
const load = (names: string[]) =>
  usePanes
    .getState()
    .setEntries("left", DIR, names.map(file), { pushHistory: false });

beforeEach(() => {
  usePanes.getState().closeAllTabs("left");
  load(["a.txt", "b.txt", "c.txt"]);
});

it("keeps cursor and selection on the renamed item after a refresh", () => {
  const p = usePanes.getState();
  p.setCursor("left", at("a.txt"));
  p.setSelected("left", ["a.txt"]);
  followRenamedEntry("left", tab().id, DIR, "a.txt", "z.txt");
  expect(cursorName()).toBe("z.txt");
  expect([...tab().selected]).toEqual(["z.txt"]);
  // 백엔드 새로고침 결과(새 이름 포함)가 와도 커서는 새 이름을 지킨다.
  load(["b.txt", "c.txt", "z.txt"]);
  expect(cursorName()).toBe("z.txt");
});

it("does nothing when the tab has moved to another folder", () => {
  const before = tab();
  followRenamedEntry(
    "left",
    before.id,
    { source: { kind: "local" }, path: "/elsewhere" },
    "a.txt",
    "z.txt",
  );
  expect(tab()).toBe(before);
});

it("a late rename does not move the cursor of another tab at the same path", () => {
  const origin = tab().id;
  const p = usePanes.getState();
  p.openTab("left");
  load(["a.txt", "b.txt", "c.txt"]);
  p.setCursor("left", at("b.txt"));
  expect(tab().id).not.toBe(origin);
  followRenamedEntry("left", origin, DIR, "a.txt", "z.txt");
  expect(cursorName()).toBe("b.txt");
  // 원래 탭은 새 이름으로 고쳐져 있다.
  const originTab = usePanes
    .getState()
    .panes.left.tabs.find((t) => t.id === origin)!;
  expect(originTab.entries.some((e) => e.name === "z.txt")).toBe(true);
});

it("reveals the renamed item when the filter or hidden setting would hide it", () => {
  const p = usePanes.getState();
  p.setFilter("left", "a");
  p.setCursor("left", at("a.txt"));
  followRenamedEntry("left", tab().id, DIR, "a.txt", "z.txt");
  expect(tab().filter).toBe("");
  load(["b.txt", "c.txt", "z.txt"]);
  expect(cursorName()).toBe("z.txt");

  if (tab().showHidden) p.toggleShowHidden("left");
  p.setCursor("left", at("b.txt"));
  followRenamedEntry("left", tab().id, DIR, "b.txt", ".b");
  expect(tab().showHidden).toBe(true);
  expect(cursorName()).toBe(".b");
});
