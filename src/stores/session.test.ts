import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePanes, isRestoredRemote, type RestoredLayout } from "./panes";
import {
  loadSession,
  snapshot,
  initSessionPersist,
  flushSessionSave,
} from "./session";

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

describe("session — 핀 탭", () => {
  beforeEach(() => mem.clear());
  const slim = (path: string, pinned?: boolean) => ({
    path,
    sortKey: "name" as const,
    sortOrder: "asc" as const,
    showHidden: false,
    viewMode: "details" as const,
    ...(pinned === undefined ? {} : { pinned }),
  });

  it("구버전 세션(pinned 없음)은 모두 일반 탭으로 복원", () => {
    usePanes.getState().restoreLayout(layout);
    expect(usePanes.getState().panes.left.tabs.map((t) => t.pinned)).toEqual([
      false,
      false,
    ]);
  });

  it("핀 저장 → 복원 왕복, 일반 탭엔 pinned 필드를 쓰지 않는다", () => {
    usePanes.getState().restoreLayout({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 1, tabs: [slim("/a", true), slim("/b")] },
        right: { activeTabIndex: 0, tabs: [slim("/c")] },
      },
    });
    const saved = snapshot();
    expect(saved.panes.left.tabs[0]!.pinned).toBe(true);
    expect("pinned" in saved.panes.left.tabs[1]!).toBe(false);
    usePanes.getState().restoreLayout(saved);
    const left = usePanes.getState().panes.left;
    expect(left.tabs.map((t) => t.pinned)).toEqual([true, false]);
    expect(left.activeTabIndex).toBe(1);
  });

  it("핀이 뒤섞인 데이터는 핀을 앞으로 모으고 저장된 활성 탭을 유지", () => {
    usePanes.getState().restoreLayout({
      activePane: "left",
      panes: {
        left: {
          activeTabIndex: 0,
          tabs: [slim("/a"), slim("/b", true), slim("/c")],
        },
        right: { activeTabIndex: 0, tabs: [slim("/d")] },
      },
    });
    const left = usePanes.getState().panes.left;
    expect(left.tabs.map((t) => String(t.location.path))).toEqual([
      "/b",
      "/a",
      "/c",
    ]);
    expect(String(left.tabs[left.activeTabIndex]!.location.path)).toBe("/a");
  });
});

describe("session — 아카이브 탭", () => {
  it("아카이브를 보던 탭은 원래 폴더로 저장된다 (핀 유지)", () => {
    usePanes.getState().restoreLayout({
      activePane: "left",
      panes: {
        left: {
          activeTabIndex: 0,
          tabs: [
            {
              path: "/docs",
              sortKey: "name",
              sortOrder: "asc",
              showHidden: false,
              viewMode: "details",
              pinned: true,
            },
          ],
        },
        right: { activeTabIndex: 0, tabs: [] },
      },
    });
    usePanes.getState().setActivePane("left");
    usePanes.getState().setArchiveContext("left", {
      label: "x.zip",
      root: "/tmp/duet-archive/abc/content",
      exitTo: { source: { kind: "local" }, path: "/docs" },
    });
    usePanes
      .getState()
      .setEntries(
        "left",
        { source: { kind: "local" }, path: "/tmp/duet-archive/abc/content" },
        [],
      );
    const saved = snapshot().panes.left.tabs;
    expect(saved).toHaveLength(1);
    expect(saved[0]!.path).toBe("/docs");
    expect(saved[0]!.pinned).toBe(true);
  });
});

describe("session — 손상 데이터", () => {
  beforeEach(() => mem.clear());
  const put = (v: unknown) =>
    localStorage.setItem("duet.session.v1", JSON.stringify(v));

  it("tabs 가 배열이 아니면 null (부팅이 throw 하지 않게)", () => {
    put({ activePane: "left", panes: { left: {}, right: {} } });
    expect(loadSession()).toBeNull();
  });

  it("잘못된 탭만 버리고 필드는 기본값으로 정규화한다", () => {
    put({
      activePane: "sideways",
      panes: {
        left: {
          tabs: [
            { path: "/ok", sortKey: "bogus", viewMode: 3, pinned: "yes" },
            { nope: 1 },
            null,
          ],
        },
        right: { activeTabIndex: 0, tabs: [] },
      },
    });
    const v = loadSession();
    expect(v?.activePane).toBe("left");
    expect(v?.panes.left.activeTabIndex).toBe(0);
    expect(v?.panes.left.tabs).toEqual([
      {
        path: "/ok",
        sortKey: "mtime",
        sortOrder: "desc",
        showHidden: false,
        viewMode: "details",
      },
    ]);
  });

  it("핀 필드는 true 일 때만 살린다", () => {
    put({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 0, tabs: [{ path: "/a", pinned: true }] },
        right: { activeTabIndex: 0, tabs: [] },
      },
    });
    expect(loadSession()?.panes.left.tabs[0]?.pinned).toBe(true);
  });
});

describe("session — 손상 탭 앞에 있는 활성 탭", () => {
  beforeEach(() => mem.clear());
  it("버려진 탭만큼 당겨져도 원래 활성 탭을 유지한다", () => {
    localStorage.setItem(
      "duet.session.v1",
      JSON.stringify({
        activePane: "left",
        panes: {
          left: {
            activeTabIndex: 1,
            tabs: [null, { path: "/wanted" }, { path: "/other" }],
          },
          right: { activeTabIndex: 0, tabs: [] },
        },
      }),
    );
    const v = loadSession()!;
    expect(v.panes.left.tabs[v.panes.left.activeTabIndex]!.path).toBe(
      "/wanted",
    );
  });
});

describe("session — 닫기 직전 저장 (browse-26)", () => {
  it("flush 는 대기 중인 저장을 즉시 쓰고, 대기 중인 게 없으면 아무것도 안 쓴다", () => {
    vi.useFakeTimers();
    try {
      initSessionPersist();
      mem.clear();
      flushSessionSave();
      expect(mem.has("duet.session.v1")).toBe(false);

      usePanes
        .getState()
        .openTab("left", { source: { kind: "local" }, path: "/flush-me" });
      expect(mem.has("duet.session.v1")).toBe(false); // 아직 디바운스 대기
      flushSessionSave();
      expect(mem.get("duet.session.v1")).toContain("/flush-me");

      // 이미 비웠으니 타이머가 다시 쓰지 않는다.
      mem.clear();
      vi.advanceTimersByTime(1000);
      expect(mem.has("duet.session.v1")).toBe(false);

      // pagehide 도 같은 flush 를 탄다.
      usePanes
        .getState()
        .openTab("left", { source: { kind: "local" }, path: "/on-pagehide" });
      window.dispatchEvent(new Event("pagehide"));
      expect(mem.get("duet.session.v1")).toContain("/on-pagehide");
    } finally {
      vi.useRealTimers();
    }
  });
});
