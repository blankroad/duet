import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

/**
 * UX smoke Phase 1 — real App with mocked IPC. No live application/SSH.
 * 하네스는 `src/__smoke__/tabs.app.smoke.test.tsx` 를 따른다 (IPC 모킹, 실제 keydown).
 * 결함 재현은 it.fails 로 표시.
 */

const dir = (name: string) => ({
  name,
  kind: "dir" as const,
  size: null,
  modified_ms: 1,
  permissions: null,
  hidden: false,
});
const file = (name: string) => ({
  ...dir(name),
  kind: "file" as const,
  size: 1,
});
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
const delay: Record<string, number> = {};
let holdSlow = false;
const slowWaiters: (() => void)[] = [];
async function releaseSlow() {
  holdSlow = false;
  await act(async () => {
    for (const resolve of slowWaiters.splice(0)) resolve();
  });
}
/** 목록 실패할 경로 (권한 없음·삭제됨 흉내). */
const failing = new Set<string>();
/** listDirectory 호출 기록 `${source.kind}:${path}`. */
const listCalls: string[] = [];
const actionCalls: { command: string; args: unknown[] }[] = [];

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
      if (
        [
          "fsCopyPlan",
          "fsMovePlan",
          "fsDeletePlan",
          "sshEditOpen",
          "openPath",
          "hostFavoritesAdd",
          "hostFavoritesRemove",
        ].includes(k)
      )
        return async (...args: unknown[]) => {
          actionCalls.push({ command: k, args });
          return {
            status: "error",
            error: { kind: "PermissionDenied", message: "fixture denied" },
          };
        };
      if (k === "listDirectory")
        return async (loc: { path: string; source: { kind: string } }) => {
          listCalls.push(`${loc.source.kind}:${loc.path}`);
          if (holdSlow && loc.path === "/home/slow")
            await new Promise<void>((resolve) => slowWaiters.push(resolve));
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
import { useCommands } from "@/stores/commands";
import { useConnections } from "@/stores/connections";
import { useHostFavorites } from "@/stores/hostFavorites";
vi.setConfig({ testTimeout: 30000 });
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import type { Location } from "@/types/bindings";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { clearClosedTabs } from "@/stores/closedTabs";
import { useToast } from "@/stores/toast";
import { useUI } from "@/stores/ui";
import { useContextMenu } from "@/stores/contextMenu";

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));
const tabL = () => activeTab(usePanes.getState(), "left");
const tabR = () => activeTab(usePanes.getState(), "right");
const key = (init: KeyboardEventInit) =>
  act(() => {
    fireEvent.keyDown(
      init.key === "Escape"
        ? (document.activeElement ?? document.body)
        : window,
      init,
    );
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

beforeEach(() => {
  cleanup();
  failing.clear();
  holdSlow = false;
  slowWaiters.splice(0);
  useConnections.setState({ active: {} });
  actionCalls.length = 0;
  useUIDialogs.getState().close();
  listCalls.length = 0;
  clearClosedTabs();
  useToast.getState().clear();
  useContextMenu.getState().close();
  if (useUI.getState().syncBrowse) useUI.getState().toggleSyncBrowse();
  localStorage.clear();
});

afterEach(cleanup);

describe("mocked IPC tabs while navigating", () => {
  it("duplicate, close, reopen while a listing is loading isolates the original response", async () => {
    await boot();
    const original = tabL().id;
    holdSlow = true;
    cursorTo("slow");
    enter();
    await wait(30);
    act(() => usePanes.getState().duplicateTab("left", 0));
    const duplicate = tabL().id;
    expect(duplicate).not.toBe(original);
    expect(tabL().loading).toBe(true);
    await wait(60);
    expect(String(tabL().location.path)).toBe("/home");
    act(() => usePanes.getState().closeTab("left", 0));
    act(() => usePanes.getState().reopenClosedTab());
    const reopened = tabL().id;
    expect(reopened).not.toBe(original);
    await releaseSlow();
    await wait(100);
    expect(tabL().id).toBe(reopened);
    expect(String(tabL().location.path)).toBe("/home");
    expect(tabL().loading).toBe(false);
  });

  it.fails(
    "ux-smoke browse-s06 swap panes while navigating must preserve the pending destination",
    async () => {
      await boot("/other");
      const original = tabL().id;
      holdSlow = true;
      cursorTo("slow");
      enter();
      await wait(30);
      key({ key: "u", code: "KeyU", ctrlKey: true });
      expect(tabR().id).toBe(original);
      await releaseSlow();
      await wait(100);
      expect(tabR().loading).toBe(false);
      expect(String(tabR().location.path)).toBe("/home/slow");
      expect(tabR().entries.map((e) => e.name)).toEqual(["late.txt"]);
    },
  );

  it.fails(
    "ux-smoke browse-s07 move tab to other pane while navigating must preserve pending destination",
    async () => {
      await boot("/other");
      const original = tabL().id;
      holdSlow = true;
      cursorTo("slow");
      enter();
      await wait(30);
      act(() => usePanes.getState().moveActiveTabToOther());
      expect(tabR().id).toBe(original);
      await releaseSlow();
      await wait(100);
      expect(String(tabR().location.path)).toBe("/home/slow");
    },
  );

  it("sync-browse mirrors a successful directory enter and skips a missing counterpart", async () => {
    await boot("/other");
    act(() => useUI.getState().toggleSyncBrowse());
    cursorTo("a");
    enter();
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home/a");
    expect(String(tabR().location.path)).toBe("/other/a");
    expect(listCalls).toContain("local:/other/a");
    // Mock the counterpart permission failure on the next upward transition.
    failing.add("/other");
    key({ key: "Backspace", code: "Backspace" });
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    expect(String(tabR().location.path)).toBe("/other/a");
  });
});

const remote: Location = {
  source: {
    kind: "ssh",
    connection_id: "fixture:live",
    host_ip: "192.0.2.1",
    user: "u",
  },
  path: "/srv",
};

describe.each(["remote", "archive"] as const)(
  "%s selection and F-keys (mocked IPC)",
  (context) => {
    async function prepare() {
      await boot("/other");
      const loc =
        context === "remote"
          ? remote
          : {
              source: { kind: "local" as const },
              path: "/fixture/archive/root",
            };
      act(() => {
        usePanes
          .getState()
          .setEntries("left", loc, [
            dir("folder"),
            file("a.txt"),
            file("b.log"),
          ]);
        usePanes.getState().setSort("left", "name", "asc");
        if (context === "archive")
          usePanes.getState().setArchiveContext("left", {
            label: "fixture.zip",
            root: String(loc.path),
            exitTo: { source: { kind: "local" }, path: "/fixture" },
          });
      });
      return loc;
    }
    it("range/select-all/invert/pattern keep source and mixed targets; F5/F6/Delete report IPC failure", async () => {
      const loc = await prepare();
      cursorTo("a.txt");
      key({ key: "ArrowDown", code: "ArrowDown", shiftKey: true });
      expect([...tabL().selected].sort()).toEqual(["a.txt", "b.log"]);
      key({ key: "a", code: "KeyA", ctrlKey: true });
      expect([...tabL().selected].sort()).toEqual(["a.txt", "b.log", "folder"]);
      key({ key: "i", code: "KeyI", ctrlKey: true, shiftKey: true });
      expect(tabL().selected.size).toBe(0);
      act(() => usePanes.getState().selectByPattern("left", "*.txt", "add"));
      expect([...tabL().selected]).toEqual(["a.txt"]);
      // Control toggle is the same store action used by Pane's Ctrl-click handler.
      act(() => usePanes.getState().toggleSelected("left", "folder"));
      key({ key: "F2", code: "F2" });
      expect(useUIDialogs.getState().dialog.kind).toBe("batch-rename");
      key({ key: "Escape", code: "Escape" });
      expect(useUIDialogs.getState().dialog.kind).toBe("none");
      key({ key: "F5", code: "F5" });
      key({ key: "F6", code: "F6" });
      key({ key: "Delete", code: "Delete" });
      await wait(30);
      for (const command of ["fsCopyPlan", "fsMovePlan", "fsDeletePlan"]) {
        const call = actionCalls.find((c) => c.command === command);
        expect(call?.args[0]).toEqual([
          { location: loc, name: "a.txt" },
          { location: loc, name: "folder" },
        ]);
      }
      expect(useToast.getState().toasts.some((t) => t.kind === "error")).toBe(
        true,
      );
      expect(useUIDialogs.getState().dialog.kind).toBe("none");
      cursorTo("a.txt");
      key({ key: "F4", code: "F4" });
      await wait(20);
      expect(
        actionCalls.find(
          (c) =>
            c.command === (context === "remote" ? "sshEditOpen" : "openPath"),
        )?.args[0],
      ).toEqual({ ...loc, path: `${loc.path}/a.txt` });
      key({ key: "F7", code: "F7" });
      expect(useUIDialogs.getState().dialog.kind).toBe("mkdir");
      key({ key: "Escape", code: "Escape" });
      expect(useUIDialogs.getState().dialog.kind).toBe("none");
    });
  },
);

it.fails(
  "ux-smoke browse-s11 Ctrl+D on bookmarked SSH folder must remove favorite like the path-bar star",
  async () => {
    await boot();
    act(() => {
      useConnections.getState().upsertActive({
        id: "fixture:live",
        alias: "fixture",
        host_ip: "192.0.2.1",
        user: "u",
        state: { kind: "connected" },
      });
      usePanes.getState().setEntries("left", remote, [file("a.txt")]);
      useHostFavorites
        .getState()
        .setAll([
          { id: "fav1", host_alias: "fixture", name: "srv", path: "/srv" },
        ]);
    });
    key({ key: "d", code: "KeyD", ctrlKey: true });
    await wait(30);
    expect(
      actionCalls.find((c) => c.command === "hostFavoritesRemove")?.args,
    ).toEqual(["fav1"]);
    expect(actionCalls.some((c) => c.command === "hostFavoritesAdd")).toBe(
      false,
    );
  },
);

it("palette favorite command for disconnected SSH host opens a cancellable connection flow", async () => {
  await boot();
  act(() => {
    useConnections.getState().setHosts([
      {
        alias: "fixture",
        hostname: "192.0.2.1",
        port: 22,
        user: "u",
        has_proxy_jump: false,
      },
    ]);
    useHostFavorites.getState().setAll([
      {
        id: "disconnected",
        host_alias: "fixture",
        name: "srv",
        path: "/srv",
      },
    ]);
  });
  const command = useCommands
    .getState()
    .dynamic.find((c) => c.id === "favorite.open:disconnected");
  expect(command).toBeTruthy();
  act(() => command?.action());
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(listCalls.some((c) => c.startsWith("ssh:"))).toBe(false);
  key({ key: "Escape", code: "Escape" });
  await wait(30);
  expect(screen.queryByRole("dialog")).toBeNull();
});
