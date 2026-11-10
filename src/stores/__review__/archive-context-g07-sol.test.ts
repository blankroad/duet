// G-07 R1 independent review tests by ux-archive-sol (adopted by lead in R2).
// Store-only, synthetic locations — no filesystem or live app.
import { beforeEach, expect, it } from "vitest";
import {
  activeTab,
  insideArchive,
  usePanes,
  type ArchiveBrowse,
} from "@/stores/panes";
import { snapshot } from "@/stores/session";
import { clearClosedTabs } from "@/stores/closedTabs";
import type { Location } from "@/types/bindings";
const loc = (path: string): Location => ({ source: { kind: "local" }, path });
const outer: ArchiveBrowse = {
  label: "outer.zip",
  root: "/tmp/duet-archive/A/content",
  exitTo: loc("/archives"),
};
const inner: ArchiveBrowse = {
  label: "inner.zip",
  root: "/tmp/duet-archive/B/content",
  exitTo: loc(outer.root + "/sub"),
};
const tab = () => activeTab(usePanes.getState(), "left");
const go = (l: Location) => usePanes.getState().setEntries("left", l, []);
function enter(a: ArchiveBrowse) {
  go(loc(a.root));
  usePanes.getState().setArchiveContext("left", a);
}
beforeEach(() => {
  clearClosedTabs();
  usePanes.getState().openTab("left", loc("/archives"));
});
it("source and separator boundaries are respected", () => {
  expect(insideArchive(loc(outer.root + "-other"), outer)).toBe(false);
  expect(
    insideArchive(
      {
        source: {
          kind: "ssh",
          connection_id: "c",
          host_ip: "127.0.0.1",
          user: "u",
        },
        path: outer.root,
      },
      outer,
    ),
  ).toBe(false);
});
it("nested session snapshot saves outer original folder", () => {
  enter(outer);
  enter(inner);
  const s = snapshot().panes.left;
  expect(s.tabs[s.activeTabIndex]?.path).toBe("/archives");
});
it("openTab clone retains Back restoration after exit", () => {
  enter(outer);
  usePanes.getState().openTab("left");
  go(loc("/archives"));
  go(loc(outer.root));
  expect(tab().archive?.label).toBe("outer.zip");
});
it("reopen nested tab returns to durable outer folder", () => {
  enter(outer);
  enter(inner);
  const index = usePanes.getState().panes.left.activeTabIndex;
  usePanes.getState().closeTab("left", index);
  usePanes.getState().reopenClosedTab();
  expect(tab().location.path).toBe("/archives");
  expect(tab().archive).toBeUndefined();
});
it("reopened nested tab does not persist a temporary path", () => {
  enter(outer);
  enter(inner);
  usePanes
    .getState()
    .closeTab("left", usePanes.getState().panes.left.activeTabIndex);
  usePanes.getState().reopenClosedTab();
  const s = snapshot().panes.left;
  expect(s.tabs[s.activeTabIndex]?.path).toBe("/archives");
});
it("overlapping archive roots restore most specific context", () => {
  enter(outer);
  const nestedRoot = { ...inner, root: outer.root + "/nested" };
  enter(nestedRoot);
  go(loc("/archives"));
  go(loc(outer.root));
  go(loc(nestedRoot.root));
  expect(tab().archive?.label).toBe("inner.zip");
});
it("trail cap bounds the array; parent chain stays intact for the durable folder", () => {
  let exitTo = loc("/archives");
  for (let i = 0; i < 30; i++) {
    const a = {
      label: `${i}.zip`,
      root: `/tmp/duet-archive/T${i}/content`,
      exitTo,
    };
    enter(a);
    exitTo = loc(a.root);
  }
  // 문서화한 상한: 배열은 20, parent 사슬(중첩 깊이)은 끊지 않는다.
  expect(tab().archiveTrail?.length).toBe(20);
  const s = snapshot().panes.left;
  expect(s.tabs[s.activeTabIndex]?.path).toBe("/archives");
});
