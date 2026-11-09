import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";

/**
 * browse 점검 R2 (sol, original harness audited) — App 수준 탐색·히스토리·세션 복원·동기 탐색 재현.
 * 하네스는 `src/__smoke__/tabs.app.smoke.test.tsx` 를 따른다 (IPC 모킹, 실제 keydown).
 * 결함 재현은 it.fails 로 표시.
 */

const dir = (name: string) => ({
  name,
  kind: "dir",
  size: null,
  modified_ms: 1,
  permissions: null,
  hidden: false,
});
const file = (name: string) => ({ ...dir(name), kind: "file", size: 1 });
const listing: Record<string, unknown[]> = {
  "/home": [dir("a"), dir("b"), dir("slow"), file("x.txt")],
  "/home/a": [file("a.txt")],
  "/home/b": [file("b.txt")],
  "/home/slow": [file("late.txt")],
  "/other": [dir("o")],
  "/other/o": [file("o.txt")],
  "/": [dir("home"), dir("other")],
  "/srv": [dir("app")],
  "/srv/app": [file("main.rs")],
};
const delay: Record<string, number> = { "/home/slow": 250 };
/** 목록 실패할 경로 (권한 없음·삭제됨 흉내). */
const failing = new Set<string>();
/** listDirectory 호출 기록 `${source.kind}:${path}`. */
const listCalls: string[] = [];

vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "linux",
  type: () => "linux",
  arch: () => "x86_64",
  version: () => "1",
  locale: async () => "en",
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn(async () => true),
  open: vi.fn(),
  save: vi.fn(),
  message: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
  convertFileSrc: (s: string) => s,
  Channel: class {},
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: async () => () => {},
    listen: async () => () => {},
    label: "main",
  }),
  WebviewWindow: class {
    static getByLabel() {
      return null;
    }
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onFocusChanged: async () => () => {},
    listen: async () => () => {},
  }),
}));
vi.mock("@/types/bindings", () => {
  const commands = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => {
      if (k === "listDirectory")
        return async (loc: { path: string; source: { kind: string } }) => {
          listCalls.push(`${loc.source.kind}:${loc.path}`);
          await new Promise((r) => setTimeout(r, delay[loc.path] ?? 20));
          if (failing.has(loc.path))
            return {
              status: "error",
              error: { kind: "NotFound", message: `no such dir: ${loc.path}` },
            };
          return { status: "ok", data: listing[loc.path] ?? [] };
        };
      if (k === "homeDirectory")
        return async () => ({ status: "ok", data: "/home" });
      if (k === "startupOpenPath")
        return async () => ({ status: "ok", data: null });
      if (k === "settingsGet") return async () => ({ status: "ok", data: {} });
      if (k === "paneWatchSet")
        return async () => ({ status: "ok", data: null });
      return async () => ({ status: "ok", data: [] });
    },
  });
  const events = new Proxy({} as Record<string, unknown>, {
    get: () => ({ listen: async () => () => {}, emit: async () => {} }),
  });
  return { commands, events };
});
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
// 이 jsdom 환경의 localStorage 는 clear 가 없다 — 세션 저장/복원 시나리오용 메모리 스텁.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
});
// jsdom 에 CSS.escape 가 없다 — Shift+F10 메뉴 위치 계산용.
if (typeof globalThis.CSS === "undefined")
  vi.stubGlobal("CSS", { escape: (v: string) => v });
Element.prototype.scrollTo = function () {};
Element.prototype.scrollIntoView = function () {};

import "@/i18n";
import App from "@/App";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  type RestoredLayout,
} from "@/stores/panes";
import { clearClosedTabs } from "@/stores/closedTabs";
import { useToast } from "@/stores/toast";
import { useUI } from "@/stores/ui";
import { useContextMenu } from "@/stores/contextMenu";
import { useConnections } from "@/stores/connections";
import type { Location } from "@/types/bindings";

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));
const L = () => usePanes.getState().panes.left;
const tabL = () => activeTab(usePanes.getState(), "left");
const tabR = () => activeTab(usePanes.getState(), "right");
const key = (init: KeyboardEventInit) =>
  act(() => {
    fireEvent.keyDown(window, init);
  });
const slim = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  sortKey: "name" as const,
  sortOrder: "asc" as const,
  showHidden: false,
  viewMode: "details" as const,
  ...extra,
});

async function boot(right = "/home") {
  // 부트스트랩은 저장된 세션이 없으면 양쪽을 home 으로 보낸다 — 세션으로 시작 상태를 준다.
  localStorage.setItem(
    "duet.session.v1",
    JSON.stringify({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 0, tabs: [slim("/home")] },
        right: { activeTabIndex: 0, tabs: [slim(right)] },
      },
    }),
  );
  render(<App />);
  await waitFor(() => expect(tabL().entries.length).toBe(4));
  await waitFor(() => expect(tabR().entries.length).toBeGreaterThan(0));
  await wait(80);
  act(() => usePanes.getState().setActivePane("left"));
  listCalls.length = 0;
}
function cursorTo(name: string, pane: "left" | "right" = "left") {
  const t = activeTab(usePanes.getState(), pane);
  const i = computeDisplayed(t).findIndex((e) => e.name === name);
  if (i < 0) throw new Error(`no entry ${name}`);
  act(() => usePanes.getState().setCursor(pane, i));
}
const enter = () => key({ key: "Enter", code: "Enter" });
const back = () => key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });

beforeEach(() => {
  cleanup();
  failing.clear();
  listCalls.length = 0;
  clearClosedTabs();
  useToast.getState().clear();
  useContextMenu.getState().close();
  if (useUI.getState().syncBrowse) useUI.getState().toggleSyncBrowse();
  localStorage.clear();
});

describe("C-11 탐색·히스토리·경쟁", () => {
  it("회귀: 느린 폴더 진입 직후 위로 가면 늦게 온 목록이 덮어쓰지 않는다", async () => {
    await boot();
    cursorTo("slow");
    enter();
    await wait(30);
    key({ key: "Backspace", code: "Backspace" }); // /home → /
    await wait(400);
    expect(String(tabL().location.path)).toBe("/");
    expect(tabL().entries.map((e) => e.name)).toEqual(["home", "other"]);
    expect(tabL().loading).toBe(false);
  });

  it("실패한 폴더 진입: 오류 토스트, 이전 목록 유지, 히스토리에 안 쌓임", async () => {
    await boot();
    failing.add("/home/b");
    cursorTo("b");
    enter();
    await wait(80);
    const t = tabL();
    expect(String(t.location.path)).toBe("/home");
    expect(t.entries).toHaveLength(4);
    expect(t.loading).toBe(false);
    expect(t.history.stack.map((l) => String(l.path))).toEqual(["/home"]);
    const toast = useToast.getState().toasts.at(-1);
    expect(toast?.kind).toBe("error");
    expect(toast?.message).toMatch(/Cannot open \/home\/b/);
  });

  it("위로 가면 떠나온 폴더에 커서가 놓인다", async () => {
    await boot();
    cursorTo("b");
    enter();
    await wait(80);
    key({ key: "Backspace", code: "Backspace" });
    await wait(80);
    const t = tabL();
    expect(computeDisplayed(t)[t.cursorIndex]?.name).toBe("b");
  });

  it("뒤로 간 뒤 새로 이동하면 앞으로 스택이 정리된다", async () => {
    await boot();
    cursorTo("a");
    enter();
    await wait(80);
    back();
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    cursorTo("b");
    enter();
    await wait(80);
    expect(tabL().history.stack.map((l) => String(l.path))).toEqual([
      "/home",
      "/home/b",
    ]);
  });

  it("browse-23 (F-opus-03): 뒤로 가기가 실패해도 히스토리 위치가 먼저 옮겨져 현재 폴더와 어긋난다", async () => {
    await boot();
    cursorTo("a");
    enter();
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home/a");
    failing.add("/home"); // 그사이 /home 이 사라졌거나 권한이 바뀜
    back();
    await wait(80);
    const t = tabL();
    expect(String(t.location.path)).toBe("/home/a"); // 화면은 그대로
    // 히스토리 위치는 지금 보이는 폴더(/home/a, index 1)를 가리켜야 한다
    expect(t.history.index).toBe(1);
  });
});

describe("C-11 우클릭 '반대 패널에서 열기'", () => {
  it("browse-04 (F-opus-02): 원격 패널의 폴더를 우클릭 → 반대 패널에서 열기 하면 반대 패널(로컬)에서 같은 경로를 연다", async () => {
    await boot();
    useConnections.setState({
      hosts: [],
      active: {
        "prod:u1": {
          id: "prod:u1",
          alias: "prod",
          host_ip: "10.0.0.7",
          user: "deploy",
          state: { kind: "connected" },
        },
      },
    });
    const srv: Location = {
      source: {
        kind: "ssh",
        connection_id: "prod:u1",
        host_ip: "10.0.0.7",
        user: "deploy",
      },
      path: "/srv",
    };
    act(() =>
      usePanes.getState().setEntries("left", srv, listing["/srv"] as never, {
        tabId: tabL().id,
      }),
    );
    cursorTo("app");
    key({ key: "F10", code: "F10", shiftKey: true }); // 컨텍스트 메뉴 (키보드)
    const item = useContextMenu
      .getState()
      .items.find((m) => "label" in m && m.label === "Open in other pane") as
      | { onSelect: () => void }
      | undefined;
    expect(item).toBeDefined();
    act(() => {
      item!.onSelect();
      useContextMenu.getState().close();
    });
    await wait(80);
    // 기대: 반대 패널이 같은 원격 호스트의 /srv/app 을 연다
    expect(listCalls).toContain("ssh:/srv/app");
    expect(tabR().location.source.kind).toBe("ssh");
  });
});

describe("C-16 동기 탐색", () => {
  it("기록: 반대 패널에 같은 이름 폴더가 없으면 조용히 건너뛰고, 다음 '위로' 에서 두 패널이 어긋난다", async () => {
    await boot("/other");
    act(() => useUI.getState().toggleSyncBrowse());
    failing.add("/other/a"); // 오른쪽엔 a 가 없다
    cursorTo("a");
    enter();
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home/a");
    expect(String(tabR().location.path)).toBe("/other"); // 조용히 건너뜀 (안내 없음)
    expect(useToast.getState().toasts).toHaveLength(0);
    key({ key: "Backspace", code: "Backspace" }); // 왼쪽 /home, 오른쪽 /other → /
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    expect(String(tabR().location.path)).toBe("/"); // 사용자는 /other 를 기대
  });

  it("기록: 뒤로/앞으로는 동기되지 않는다", async () => {
    await boot("/other");
    act(() => useUI.getState().toggleSyncBrowse());
    cursorTo("a");
    enter();
    await wait(80);
    back();
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    expect(String(tabR().location.path)).toBe("/other/a"); // 오른쪽은 따라오지 않음
  });
});

describe("C-10 세션 복원", () => {
  const saveLayout = (layout: RestoredLayout) =>
    localStorage.setItem("duet.session.v1", JSON.stringify(layout));

  it.fails(
    "browse-15 (F-opus-04): 복원한 탭의 로컬 폴더가 사라졌으면 패널에 '빈 폴더' 가 표시된다",
    async () => {
      failing.add("/gone");
      saveLayout({
        activePane: "left",
        panes: {
          left: { activeTabIndex: 0, tabs: [slim("/gone")] },
          right: { activeTabIndex: 0, tabs: [slim("/home")] },
        },
      });
      render(<App />);
      await waitFor(() => expect(tabR().entries.length).toBe(4));
      await wait(80);
      expect(String(tabL().location.path)).toBe("/gone");
      // 토스트는 8초 뒤 사라진다 — 패널 자체가 실패를 보여야 한다
      expect(screen.queryAllByText("This folder is empty")).toHaveLength(0);
    },
  );

  it("이미 알려짐(StrictMode 부트스트랩): 저장된 활성 탭(1번)이 복원되는가", async () => {
    saveLayout({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 1, tabs: [slim("/home"), slim("/other")] },
        right: { activeTabIndex: 0, tabs: [slim("/home")] },
      },
    });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    await wait(400);
    // R1 실행 결과: activeTabIndex=1 (이 하네스에선 알려진 문제가 재현되지 않음)
    expect(L().tabs.length).toBe(2);
    expect(L().activeTabIndex).toBe(1);
  });

  it("기록: 부팅 복원 시 탭마다 목록을 몇 번 읽는가 (탭 전환 effect 의 새로고침 중복)", async () => {
    saveLayout({
      activePane: "left",
      panes: {
        left: {
          activeTabIndex: 0,
          tabs: [slim("/home"), slim("/other"), slim("/srv")],
        },
        right: { activeTabIndex: 0, tabs: [slim("/home")] },
      },
    });
    render(<App />);
    await wait(500);
    const count = (p: string) =>
      listCalls.filter((c) => c === `local:${p}`).length;
    // R1 실행 결과: /home=4 /other=1 /srv=1 (왼쪽·오른쪽 /home 이 각 2번 — 루프 뒤
    // selectTab(savedActive) 가 탭 전환 effect 의 새로고침을 한 번 더 부른다)
    expect(count("/other")).toBe(1);
    expect(count("/srv")).toBe(1);
    expect(L().activeTabIndex).toBe(0);
  });

  it("손상 세션(tabs 가 배열 아님)은 기본 home 으로 부팅한다", async () => {
    localStorage.setItem(
      "duet.session.v1",
      JSON.stringify({
        activePane: "left",
        panes: { left: { tabs: "x" }, right: {} },
      }),
    );
    render(<App />);
    await waitFor(() => expect(String(tabL().location.path)).toBe("/home"));
  });
});

import { useBookmarks } from "@/stores/bookmarks";
import { useNotices } from "@/stores/notices";

it("browse-05: sidebar remote bookmark keeps the same tab and Back must restore local source", async () => {
  await boot();
  const previousId = tabL().id;
  const previousCount = L().tabs.length;
  const source = {
    kind: "ssh" as const,
    connection_id: "r2:u1",
    host_ip: "10.0.0.8",
    user: "review",
  };
  act(() => {
    useConnections.getState().upsertActive({
      id: source.connection_id,
      alias: "r2",
      host_ip: source.host_ip,
      user: source.user,
      state: { kind: "connected" },
    });
    useBookmarks.getState().setAll([
      {
        id: "r2-bm",
        name: "R2 remote bookmark",
        location: { source, path: "/srv" },
      },
    ]);
  });
  fireEvent.click(screen.getByText("R2 remote bookmark"));
  await waitFor(() => expect(tabL().location.source.kind).toBe("ssh"));
  expect(tabL().id).toBe(previousId);
  expect(L().tabs.length).toBe(previousCount);
  listCalls.length = 0;
  back();
  await wait(100);
  expect(listCalls).toContain("local:/home");
  expect(tabL().location.source.kind).toBe("local");
});

it.fails(
  "browse-30: directory failure preserves the backend original in notice detail",
  async () => {
    await boot();
    useNotices.getState().clear();
    failing.add("/home/b");
    cursorTo("b");
    enter();
    await wait(100);
    const notice = useNotices.getState().items[0];
    expect(notice?.kind).toBe("error");
    expect(notice?.message).toContain("Cannot open");
    expect(notice?.detail).toContain("no such dir: /home/b");
  },
);
