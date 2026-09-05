import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanes, isRestoredRemote, type RestoredLayout } from "./panes";
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

describe("session restore — 원격 탭", () => {
  beforeEach(() => mem.clear());

  /**
   * 예전에는 SSH 탭을 통째로 버려서 재시작하면 원격 작업 문맥이 사라졌다.
   * 이제 alias+경로로 복원하고, 패널이 "연결 끊김" 배너로 다시 연결을 제안한다.
   */
  it("host(alias)가 있으면 ssh 탭으로 복원하고 재연결 대상으로 표시한다", () => {
    usePanes.getState().restoreLayout({
      activePane: "left",
      panes: {
        left: {
          activeTabIndex: 0,
          tabs: [
            {
              path: "/var/log",
              host: "prod",
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
    const tab = usePanes.getState().panes.left.tabs[0]!;
    expect(tab.location.source.kind).toBe("ssh");
    expect(String(tab.location.path)).toBe("/var/log");
    expect(isRestoredRemote(tab.location)).toBe(true);
    // 배너가 alias 를 뽑아 쓰는 자리 — connection_id 앞부분.
    if (tab.location.source.kind === "ssh")
      expect(tab.location.source.connection_id.split(":")[0]).toBe("prod");
  });

  it("host 가 없으면 예전처럼 로컬 탭", () => {
    usePanes.getState().restoreLayout(layout);
    const tab = usePanes.getState().panes.left.tabs[0]!;
    expect(tab.location.source.kind).toBe("local");
    expect(isRestoredRemote(tab.location)).toBe(false);
  });
});
