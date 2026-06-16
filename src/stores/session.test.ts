import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanes, type RestoredLayout } from "./panes";
import { loadSession } from "./session";

// 이 jsdom 환경의 localStorage 는 기능이 없어(=recents 가 try/catch 로 감싸는 이유)
// 인메모리로 stub.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    mem.set(k, v);
  },
  removeItem: (k: string) => {
    mem.delete(k);
  },
  clear: () => mem.clear(),
});

const layout: RestoredLayout = {
  activePane: "right",
  panes: {
    left: {
      activeTabIndex: 1,
      tabs: [
        {
          path: "/a",
          sortKey: "name",
          sortOrder: "asc",
          showHidden: false,
          viewMode: "details",
        },
        {
          path: "/b",
          sortKey: "size",
          sortOrder: "desc",
          showHidden: true,
          viewMode: "grid",
        },
      ],
    },
    right: {
      activeTabIndex: 0,
      tabs: [
        {
          path: "/c",
          sortKey: "mtime",
          sortOrder: "asc",
          showHidden: false,
          viewMode: "tiles",
        },
      ],
    },
  },
};

describe("session restore", () => {
  beforeEach(() => mem.clear());

  it("restoreLayout rebuilds tabs with saved paths + sort/view (local source)", () => {
    usePanes.getState().restoreLayout(layout);
    const s = usePanes.getState();
    expect(s.activePane).toBe("right");
    expect(s.panes.left.tabs.map((t) => String(t.location.path))).toEqual([
      "/a",
      "/b",
    ]);
    expect(s.panes.left.activeTabIndex).toBe(1);
    expect(s.panes.left.tabs[1]!.sortKey).toBe("size");
    expect(s.panes.left.tabs[1]!.sortOrder).toBe("desc");
    expect(s.panes.left.tabs[1]!.viewMode).toBe("grid");
    expect(s.panes.left.tabs[1]!.showHidden).toBe(true);
    expect(
      s.panes.left.tabs.every((t) => t.location.source.kind === "local"),
    ).toBe(true);
    expect(s.panes.right.tabs.map((t) => String(t.location.path))).toEqual([
      "/c",
    ]);
  });

  it("restoreLayout with empty tabs falls back to a single home tab", () => {
    usePanes.getState().restoreLayout({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 0, tabs: [] },
        right: { activeTabIndex: 5, tabs: [] },
      },
    });
    const s = usePanes.getState();
    expect(s.panes.left.tabs.length).toBe(1);
    expect(s.panes.right.tabs.length).toBe(1);
  });

  it("restoreLayout clamps out-of-range activeTabIndex", () => {
    usePanes.getState().restoreLayout({
      activePane: "left",
      panes: {
        left: {
          activeTabIndex: 99,
          tabs: [
            {
              path: "/x",
              sortKey: "name",
              sortOrder: "asc",
              showHidden: false,
              viewMode: "details",
            },
          ],
        },
        right: { activeTabIndex: 0, tabs: [] },
      },
    });
    expect(usePanes.getState().panes.left.activeTabIndex).toBe(0);
  });

  it("loadSession: null when empty/corrupt, parsed when valid", () => {
    expect(loadSession()).toBeNull();
    localStorage.setItem("duet.session.v1", "not json{");
    expect(loadSession()).toBeNull();
    localStorage.setItem("duet.session.v1", JSON.stringify(layout));
    expect(loadSession()?.activePane).toBe("right");
  });
});
