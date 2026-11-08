import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

/**
 * browse 점검 R2 (opus 교차 검토) — App 수준: 변경 이벤트 폭주(browse-13), 커서 폴더 크기
 * (browse-09), 북마크 이동(C-20), 압축 내부 보기 문맥(C-21).
 * 하네스는 opus R1 `browse-app-nav.test.tsx` 와 같다(IPC 모킹 + 실제 keydown). 결함 재현은 it.fails.
 */

const dir = (name: string) => ({
  name,
  kind: "dir",
  size: null,
  modified_ms: 1,
  permissions: null,
  hidden: false,
});

it.fails(
  "browse-32 (F-opus-201): returning to extracted content restores repack controls and session destination",
  async () => {
    await boot();
    cursorTo("x.zip");
    key({ key: "Enter", code: "Enter" });
    await waitFor(() => expect(tabL().archive?.label).toBe("x.zip"));
    expect(archiveRequests[0]).toEqual({
      location: { source: { kind: "local" }, path: "/home" },
      name: "x.zip",
    });
    expect(
      screen.getAllByRole("button", { name: "Update archive" }),
    ).toHaveLength(1);
    key({ key: "Backspace", code: "Backspace" });
    await waitFor(() => expect(tabL().location.path).toBe("/home"));
    back();
    await waitFor(() =>
      expect(tabL().location.path).toBe("/tmp/duet-archive/r3-token/content"),
    );
    const observed = {
      archive: tabL().archive ?? null,
      sessionPath: snapshot().panes.left.tabs[0]?.path,
      updateButtons: screen.queryAllByRole("button", { name: "Update archive" })
        .length,
    };
    console.info("browse-sol3-archive-context", JSON.stringify(observed));
    expect(observed.sessionPath).toBe("/home");
    expect(observed.updateButtons).toBe(1);
  },
);

function setStartupSession(host?: string) {
  localStorage.setItem(
    "duet.session.v1",
    JSON.stringify({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 0, tabs: [slim("/srv", host ? { host } : {})] },
        right: { activeTabIndex: 0, tabs: [slim("/home")] },
      },
    }),
  );
}

it.fails(
  "browse-05: startup local path overrides the restored remote source",
  async () => {
    setStartupSession("r3-prod");
    startup.path = "/r3-startup-local";
    render(<App />);
    await waitFor(() =>
      expect(listCalls.some((c) => c.endsWith(":/r3-startup-local"))).toBe(
        true,
      ),
    );
    const request = listLocations.find(
      (loc) => loc.path === "/r3-startup-local",
    );
    console.info("browse-sol3-startup", JSON.stringify(request));
    expect(request?.source.kind).toBe("local");
    expect(tabL().location.source.kind).toBe("local");
  },
);

it("R3 control: startup local path succeeds when the restored tab is local", async () => {
  setStartupSession();
  startup.path = "/r3-startup-local";
  render(<App />);
  await waitFor(() => expect(tabL().location.path).toBe("/r3-startup-local"));
  expect(listCalls).toContain("local:/r3-startup-local");
  expect(tabL().location.source.kind).toBe("local");
});

it.fails(
  "browse-05: a retained search hit uses its original source after the pane source changes",
  async () => {
    await boot();
    act(() =>
      useSearch
        .getState()
        .open("left", { source: { kind: "local" }, path: "/home" }),
    );
    const source = {
      kind: "ssh" as const,
      connection_id: "r3-live:id",
      host_ip: "10.0.0.9",
      user: "review",
    };
    act(() => {
      useConnections.getState().upsertActive({
        id: source.connection_id,
        alias: "r3-live",
        host_ip: source.host_ip,
        user: source.user,
        state: { kind: "connected" },
      });
      usePanes
        .getState()
        .setEntries("left", { source, path: "/srv" }, listing["/srv"] as never);
    });
    act(() =>
      useSearch.getState().setResults([
        {
          location: { source: { kind: "local" }, path: "/home/a" },
          name: "a.txt",
          kind: "file",
          size: 1,
          modified_ms: 1,
        },
      ]),
    );
    listCalls.length = 0;
    fireEvent.click(screen.getByText("a.txt"));
    await waitFor(() =>
      expect(listCalls.some((c) => c.endsWith(":/home/a"))).toBe(true),
    );
    console.info("browse-sol3-search", JSON.stringify(listCalls));
    expect(listCalls).toContain("local:/home/a");
  },
);
const file = (name: string) => ({ ...dir(name), kind: "file", size: 1 });
const listing: Record<string, unknown[]> = {
  "/r3-startup-local": [file("startup-target.txt")],
  "/home": [dir("a"), dir("b"), dir("slow"), file("x.zip")],
  "/home/a": [file("a.txt")],
  "/home/b": [file("b.txt")],
  "/home/slow": [file("late.txt")],
  "/other": [dir("o")],
  "/other/o": [file("o.txt")],
  "/": [dir("home"), dir("other")],
  "/srv": [dir("app")],
  "/srv/app": [file("main.rs")],
  "/tmp/duet-archive/r3-token/content": [dir("inner"), file("in.txt")],
  "/tmp/duet-archive/r3-token/content/inner": [file("deep.txt")],
  "/w": [
    { ...dir("old"), modified_ms: 100 },
    { ...dir("mid"), modified_ms: 200 },
    { ...dir("new"), modified_ms: 300 },
    { ...file("z.txt"), modified_ms: 50 },
  ],
};
/** paneWatchSet 호출 기록 [pane, path]. */
const watchCalls: Array<[string, string]> = [];
/** fsDirSize 호출 경로. */
const sizeCalls: string[] = [];
/** 이벤트 리스너 (fsChangedEvent 등) — 테스트가 직접 발행한다. */
const listeners: Record<string, (e: unknown) => void> = {};
const delay: Record<string, number> = { "/home/slow": 250 };
/** 목록 실패할 경로 (권한 없음·삭제됨 흉내). */
const failing = new Set<string>();
/** listDirectory 호출 기록 `${source.kind}:${path}`. */
const listCalls: string[] = [];
const listLocations: Location[] = [];
const archiveRequests: EntryRef[] = [];
const startup = { path: null as string | null };

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
        return async (loc: Location) => {
          listCalls.push(`${loc.source.kind}:${loc.path}`);
          listLocations.push(loc);
          if (
            loc.source.kind === "ssh" &&
            loc.source.connection_id.endsWith(":restored")
          )
            return {
              status: "error",
              error: {
                kind: "ConnectionFailed",
                message: "no connection for restored tab",
              },
            };
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
        return async () => ({ status: "ok", data: startup.path });
      if (k === "settingsGet") return async () => ({ status: "ok", data: {} });
      if (k === "paneWatchSet")
        return async (pane: string, loc: { path: string }) => {
          watchCalls.push([pane, loc.path]);
          return { status: "ok", data: null };
        };
      if (k === "fsDirSize")
        return async (loc: { path: string }) => {
          sizeCalls.push(loc.path);
          return { status: "ok", data: 42 };
        };
      if (k === "fsArchiveOpenForBrowse")
        return async (archive: EntryRef) => {
          archiveRequests.push(archive);
          return {
            status: "ok",
            data: {
              source: { kind: "local" },
              path: "/tmp/duet-archive/r3-token/content",
            },
          };
        };
      return async () => ({ status: "ok", data: [] });
    },
  });
  const events = new Proxy({} as Record<string, unknown>, {
    get: (_t, name: string) => ({
      listen: async (cb: (e: unknown) => void) => {
        listeners[name] = cb;
        return () => {};
      },
      emit: async () => {},
    }),
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
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import { clearClosedTabs } from "@/stores/closedTabs";
import { useToast } from "@/stores/toast";
import type { EntryRef, Location } from "@/types/bindings";
import { snapshot } from "@/stores/session";
import { useSearch } from "@/stores/search";
import { useConnections } from "@/stores/connections";
import { screen } from "@testing-library/react";

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));
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

async function boot(left = "/home", right = "/home", leftExtra = {}) {
  localStorage.setItem(
    "duet.session.v1",
    JSON.stringify({
      activePane: "left",
      panes: {
        left: { activeTabIndex: 0, tabs: [slim(left, leftExtra)] },
        right: { activeTabIndex: 0, tabs: [slim(right)] },
      },
    }),
  );
  render(<App />);
  await waitFor(() => expect(tabL().entries.length).toBeGreaterThan(0));
  await waitFor(() => expect(tabR().entries.length).toBeGreaterThan(0));
  await wait(80);
  act(() => usePanes.getState().setActivePane("left"));
  listCalls.length = 0;
  watchCalls.length = 0;
  sizeCalls.length = 0;
}
function cursorTo(name: string) {
  const i = computeDisplayed(tabL()).findIndex((e) => e.name === name);
  if (i < 0) throw new Error(`no entry ${name}`);
  act(() => usePanes.getState().setCursor("left", i));
}
const back = () => key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });

beforeEach(() => {
  cleanup();
  startup.path = null;
  archiveRequests.length = 0;
  listLocations.length = 0;
  useSearch.getState().close();
  failing.clear();
  listCalls.length = 0;
  watchCalls.length = 0;
  sizeCalls.length = 0;
  clearClosedTabs();
  useToast.getState().clear();
  localStorage.clear();
});

describe("C-21 압축 내부 보기 문맥", () => {
  async function openZip() {
    await boot();
    cursorTo("x.zip");
    key({ key: "Enter", code: "Enter" });
    await wait(150);
    expect(String(tabL().location.path)).toBe(
      "/tmp/duet-archive/r3-token/content",
    );
    expect(tabL().archive?.label).toBe("x.zip");
  }

  it("아카이브 하위 폴더 → 위로 → 아카이브 루트 → 위로 = 원래 폴더로 나간다", async () => {
    await openZip();
    cursorTo("inner");
    key({ key: "Enter", code: "Enter" });
    await wait(80);
    expect(tabL().archive?.label).toBe("x.zip");
    key({ key: "Backspace", code: "Backspace" });
    await wait(80);
    expect(String(tabL().location.path)).toBe(
      "/tmp/duet-archive/r3-token/content",
    );
    expect(tabL().archive?.label).toBe("x.zip");
    key({ key: "Backspace", code: "Backspace" });
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    expect(tabL().archive).toBeUndefined();
  });

  it.fails(
    "browse-32 (F-opus-201): 아카이브에서 나온 뒤 '뒤로' 가면 문맥 없이 임시 추출 폴더로 들어간다",
    async () => {
      await openZip();
      key({ key: "Backspace", code: "Backspace" }); // 나가기 → /home
      await wait(80);
      expect(String(tabL().location.path)).toBe("/home");
      back();
      await wait(80);
      // 뒤로 = 임시 폴더 /tmp/duet-archive/r3-token/content 로 돌아왔는데 아카이브 문맥이 없다:
      // 브레드크럼에 임시 경로, 위로 = /tmp, "아카이브 갱신" 없음, 탭 제목 = "ex"
      expect(String(tabL().location.path)).toBe(
        "/tmp/duet-archive/r3-token/content",
      );
      expect(tabL().archive?.label).toBe("x.zip");
    },
  );

  it.fails(
    "browse-34 (F-opus-202): 아카이브 루트에서 위로 나가면 커서가 아카이브 파일이 아니라 맨 위에 놓인다",
    async () => {
      await openZip();
      key({ key: "Backspace", code: "Backspace" });
      await wait(80);
      const t = tabL();
      expect(computeDisplayed(t)[t.cursorIndex]?.name).toBe("x.zip");
    },
  );
});
