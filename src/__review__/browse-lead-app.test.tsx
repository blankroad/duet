import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

/**
 * browse 점검(lead) 재현 — App 수준. 하네스는 tabs.app.smoke 에서 복사.
 * (원 설명) tabs 팀 App 수준 스모크 — App 전체(키보드 훅·탭 전환 effect·navigate)를 IPC 모킹으로
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
  "/home": [dir("a"), dir("b"), dir("slow"), file("x.zip")],
  "/tmp/ex": [file("in.txt")],
  "/home/a": [file("a.txt")],
  "/home/b": [file("b.txt")],
  "/home/slow": [file("late.txt")],
  "/other": [file("o.txt")],
};
/** 경로별 응답 지연(ms) — 늦은 응답 시나리오용. */
const delay: Record<string, number> = { "/home/slow": 250 };
const listCalls: string[] = [];
/** listDirectory 로 들어온 (source.kind, path) 기록. */
const listSources: Array<[string, string]> = [];
/** paneWatchSet 호출 기록 [pane, path] — 감시자가 보이는 탭을 따라가는지. */
const watchCalls: Array<[string, string]> = [];
/** true 면 아카이브 열기가 실패한다. */
const archive = { fail: false };

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
          listCalls.push(loc.path);
          listSources.push([loc.source.kind, loc.path]);
          await new Promise((r) => setTimeout(r, delay[loc.path] ?? 20));
          return { status: "ok", data: listing[loc.path] ?? [] };
        };
      if (k === "homeDirectory")
        return async () => ({ status: "ok", data: "/home" });
      if (k === "startupOpenPath")
        return async () => ({ status: "ok", data: null });
      if (k === "settingsGet") return async () => ({ status: "ok", data: {} });
      // 아카이브 추출은 느리다 — 그 사이 탭 조작 시나리오용.
      if (k === "paneWatchSet")
        return async (pane: string, loc: { path: string }) => {
          watchCalls.push([pane, loc.path]);
          return { status: "ok", data: null };
        };
      if (k === "fsArchiveOpenForBrowse")
        return async () => {
          await new Promise((r) => setTimeout(r, 200));
          if (archive.fail)
            return {
              status: "error",
              error: { kind: "Io", message: "bad archive" },
            };
          return {
            status: "ok",
            data: { source: { kind: "local" }, path: "/tmp/ex" },
          };
        };
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
// jsdom 레이아웃 없음 — 가상 스크롤이 행을 그리게 크기를 준다 (file-view.smoke 와 같은 방식).
{
  const size = (w: number, h: number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-drop-pane") ? h : w;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", size(400, 400));
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", size(600, 600));
  Object.defineProperty(HTMLElement.prototype, "clientHeight", size(400, 400));
  Object.defineProperty(HTMLElement.prototype, "clientWidth", size(600, 600));
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 400,
      right: 600,
      width: 600,
      height: 400,
      toJSON: () => ({}),
    } as DOMRect;
  };
}
Element.prototype.scrollIntoView = function () {};

import i18n from "@/i18n";
import App from "@/App";
import { usePanes, activeTab } from "@/stores/panes";

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));

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
    expect(activeTab(usePanes.getState(), "left").entries.length).toBe(4),
  );
  await wait(80);
}

describe("browse-lead: 뒤로 가기가 다른 소스(로컬↔원격) 히스토리를 따라가는가", () => {
  it.fails(
    "browse-05: 로컬 → (같은 탭에서) 원격으로 이동 후 뒤로 가기는 로컬 폴더를 로컬에서 읽어야 한다",
    async () => {
      await boot();
      const remote = {
        kind: "ssh" as const,
        connection_id: "srv:u1",
        host_ip: "10.0.0.7",
        user: "deploy",
      };
      // 사이드바 호스트/북마크 열기(navigateTo)가 하는 것과 같은 상태 변화:
      // 같은 탭에 원격 목록을 히스토리에 쌓는다.
      act(() =>
        usePanes
          .getState()
          .setEntries("left", { source: remote, path: "/other" }, [], {
            tabId: activeTab(usePanes.getState(), "left").id,
            pushHistory: true,
          }),
      );
      expect(activeTab(usePanes.getState(), "left").history.stack).toHaveLength(
        2,
      );
      listSources.length = 0;
      const backBtns = document.querySelectorAll(
        `button[aria-label="${i18n.t("pathbar.back")}"]`,
      );
      act(() => {
        fireEvent.click(backBtns[0]!);
      });
      await wait(80);
      // 기대: 로컬 /home 을 로컬 소스로 다시 읽는다.
      expect(listSources).toContainEqual(["local", "/home"]);
      expect(activeTab(usePanes.getState(), "left").location.source.kind).toBe(
        "local",
      );
    },
  );
});
