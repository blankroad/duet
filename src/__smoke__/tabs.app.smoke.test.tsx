import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * tabs 팀 App 수준 스모크 — App 전체(키보드 훅·탭 전환 effect·navigate)를 IPC 모킹으로
 * 렌더하고 실제 keydown 으로 사용자 흐름을 재현한다. Pane 스모크(`pane/__smoke__`)가
 * 못 보는 배선(명령 ↔ 목록 로드 ↔ 늦은 응답)을 확인한다. (opus 워커 하네스 기반)
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
  "/home": [dir("a"), dir("b"), dir("slow")],
  "/home/a": [file("a.txt")],
  "/home/b": [file("b.txt")],
  "/home/slow": [file("late.txt")],
  "/other": [file("o.txt")],
};
/** 경로별 응답 지연(ms) — 늦은 응답 시나리오용. */
const delay: Record<string, number> = { "/home/slow": 250 };
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
        return async (loc: { path: string }) => {
          listCalls.push(loc.path);
          await new Promise((r) => setTimeout(r, delay[loc.path] ?? 20));
          return { status: "ok", data: listing[loc.path] ?? [] };
        };
      if (k === "homeDirectory")
        return async () => ({ status: "ok", data: "/home" });
      if (k === "startupOpenPath")
        return async () => ({ status: "ok", data: null });
      if (k === "settingsGet") return async () => ({ status: "ok", data: {} });
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
Element.prototype.scrollTo = function () {};
Element.prototype.scrollIntoView = function () {};

import "@/i18n";
import App from "@/App";
import { usePanes, activeTab, computeDisplayed } from "@/stores/panes";
import { clearClosedTabs } from "@/stores/closedTabs";
import { useToast } from "@/stores/toast";

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));
const L = () => usePanes.getState().panes.left;
const paths = () => L().tabs.map((t) => String(t.location.path));
const key = (init: KeyboardEventInit) =>
  act(() => {
    fireEvent.keyDown(window, init);
  });

/** 매 시나리오: 양쪽 한 장(/home)으로 초기화한 뒤 App 을 띄우고 목록 로드를 기다린다. */
async function boot() {
  const slim = {
    path: "/home",
    sortKey: "name" as const,
    sortOrder: "asc" as const,
    showHidden: false,
    viewMode: "details" as const,
  };
  usePanes.getState().restoreLayout({
    activePane: "left",
    panes: {
      left: { activeTabIndex: 0, tabs: [slim] },
      right: { activeTabIndex: 0, tabs: [slim] },
    },
  });
  render(<App />);
  await waitFor(() =>
    expect(activeTab(usePanes.getState(), "left").entries.length).toBe(3),
  );
  await wait(80);
  act(() => usePanes.getState().setActivePane("left"));
  listCalls.length = 0;
}
function cursorTo(name: string) {
  const i = computeDisplayed(activeTab(usePanes.getState(), "left")).findIndex(
    (e) => e.name === name,
  );
  act(() => usePanes.getState().setCursor("left", i));
}

beforeEach(() => {
  clearClosedTabs();
  useToast.getState().clear();
});

describe("App — 탭 키보드 흐름", () => {
  it("Ctrl+↑ 는 커서 폴더를 현재 탭 바로 오른쪽 새 탭에 연다", async () => {
    await boot();
    cursorTo("b");
    key({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true });
    await wait(120);
    expect(paths()).toEqual(["/home", "/home/b"]);
    expect(L().activeTabIndex).toBe(1);
    expect(activeTab(usePanes.getState(), "left").entries).toHaveLength(1);
    expect(listCalls).toContain("/home/b");
  });

  it("0번 활성 탭을 닫으면 새로 보이는 탭을 다시 읽는다", async () => {
    await boot();
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/other",
      }),
    );
    await wait(80);
    act(() => usePanes.getState().selectTab("left", 0));
    await wait(80);
    listCalls.length = 0;
    key({ key: "w", code: "KeyW", ctrlKey: true });
    await wait(80);
    expect(paths()).toEqual(["/other"]);
    expect(listCalls).toContain("/other");
  });

  it("Ctrl+W 는 고정 탭을 닫지 않고 안내, Ctrl+Shift+T 는 닫은 탭을 되살린다", async () => {
    await boot();
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/other",
      }),
    );
    await wait(60);
    act(() => usePanes.getState().togglePinTab("left", 1)); // /other 고정 → 0번
    await wait(60);
    expect(paths()).toEqual(["/other", "/home"]);
    act(() => usePanes.getState().selectTab("left", 0));
    key({ key: "w", code: "KeyW", ctrlKey: true });
    expect(paths()).toEqual(["/other", "/home"]);
    expect(useToast.getState().toasts.at(-1)?.message).toMatch(/Pinned/);
    act(() => usePanes.getState().selectTab("left", 1));
    key({ key: "w", code: "KeyW", ctrlKey: true });
    expect(paths()).toEqual(["/other"]);
    key({ key: "T", code: "KeyT", ctrlKey: true, shiftKey: true });
    await wait(60);
    expect(paths()).toEqual(["/other", "/home"]);
  });

  it("Ctrl+Shift+PageDown 은 탭을 옮기고 파일을 선택하지 않는다", async () => {
    await boot();
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/other",
      }),
    );
    await wait(60);
    act(() => usePanes.getState().selectTab("left", 0));
    await wait(60);
    const id0 = L().tabs[0]!.id;
    key({ key: "PageDown", code: "PageDown", ctrlKey: true, shiftKey: true });
    const moved = L().tabs.findIndex((t) => t.id === id0);
    expect(moved).toBe(1);
    expect(L().tabs[moved]!.selected.size).toBe(0);
  });

  it("느린 폴더를 여는 중 다른 탭으로 가도 그 탭이 덮어써지지 않는다", async () => {
    await boot();
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/other",
      }),
    );
    await wait(60);
    act(() => usePanes.getState().selectTab("left", 0));
    await wait(60);
    cursorTo("slow");
    key({ key: "Enter", code: "Enter" });
    key({ key: "Tab", code: "Tab", ctrlKey: true }); // 응답 전에 다음 탭으로
    // 전제: 같은 패널에서 탭이 실제로 바뀌었다 (패널 전환 아님)
    expect(usePanes.getState().activePane).toBe("left");
    expect(L().activeTabIndex).toBe(1);
    await wait(400);
    expect(paths()[1]).toBe("/other");
    expect(L().tabs[1]!.entries.map((e) => e.name)).toEqual(["o.txt"]);
  });

  it("Ctrl+Tab / Ctrl+Shift+Tab 은 같은 패널의 탭을 순환한다 (패널은 그대로)", async () => {
    await boot();
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/other",
      }),
    );
    await wait(60);
    act(() => usePanes.getState().selectTab("left", 0));
    key({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(usePanes.getState().activePane).toBe("left");
    expect(L().activeTabIndex).toBe(1);
    key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
    expect(usePanes.getState().activePane).toBe("left");
    expect(L().activeTabIndex).toBe(0);
    // 수식키 없는 Tab 은 여전히 패널 전환
    key({ key: "Tab", code: "Tab" });
    expect(usePanes.getState().activePane).toBe("right");
  });
});
