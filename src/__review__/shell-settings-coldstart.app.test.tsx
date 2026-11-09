import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

// 이 jsdom(Node 25) 환경의 localStorage 는 기능이 없어 인메모리로 stub (session.test.ts 와 같은 방식).
// 앱 모듈이 import 시점에 읽으므로 hoisted 로 먼저 깐다.
vi.hoisted(() => {
  const mem = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, String(v)),
      removeItem: (k: string) => void mem.delete(k),
      clear: () => mem.clear(),
      key: (i: number) => [...mem.keys()][i] ?? null,
      get length() {
        return mem.size;
      },
    },
  });
});

/**
 * shell-settings R2 (opus) — shell-settings-08 독립 재현.
 * 지난 세션의 왼쪽 활성 탭이 SSH 였던 상태에서 탐색기 "duet 에서 열기"(cold start, argv 로컬 폴더)로
 * 앱을 켜면, 그 로컬 폴더를 죽은 SSH 연결로 요청한다.
 * 하네스(모킹)는 `src/__smoke__/tabs.app.smoke.test.tsx` 에서 가져왔다.
 *
 * (원본 하네스 설명)
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
/** listDirectory 요청의 `<source kind>:<path>`. */
const listSources: string[] = [];
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
          listSources.push(`${loc.source.kind}:${loc.path}`);
          if (loc.source.kind === "ssh")
            return {
              status: "error",
              error: {
                kind: "ConnectionFailed",
                message: "no such connection",
              },
            };
          await new Promise((r) => setTimeout(r, delay[loc.path] ?? 20));
          return { status: "ok", data: listing[loc.path] ?? [] };
        };
      if (k === "homeDirectory")
        return async () => ({ status: "ok", data: "/home" });
      if (k === "startupOpenPath")
        return async () => ({ status: "ok", data: "/home/b" });
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
Element.prototype.scrollIntoView = function () {};

import "@/i18n";
import App from "@/App";
import { usePanes, activeTab } from "@/stores/panes";
import { useToast } from "@/stores/toast";

const wait = (ms: number) =>
  act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe("shell-settings-08 cold start", () => {
  it("shell-settings-08: 복원된 왼쪽 활성 탭이 SSH 여도 시작 경로(로컬 폴더)는 로컬로 열린다", async () => {
    const tab = (path: string, host?: string) => ({
      path,
      ...(host ? { host } : {}),
      sortKey: "name",
      sortOrder: "asc",
      showHidden: false,
      viewMode: "details",
    });
    localStorage.setItem(
      "duet.session.v1",
      JSON.stringify({
        activePane: "left",
        panes: {
          left: { activeTabIndex: 0, tabs: [tab("/srv/app", "prod")] },
          right: { activeTabIndex: 0, tabs: [tab("/home")] },
        },
      }),
    );
    render(<App />);
    await wait(400);
    // 관찰용: 어떤 source 로 무엇을 요청했나.
    const left = activeTab(usePanes.getState(), "left");
    const toasts = useToast.getState().toasts.map((t) => t.message);
    expect(
      listSources,
      `left=${left.location.source.kind}:${String(left.location.path)} toasts=${JSON.stringify(toasts)}`,
    ).toContain("local:/home/b");
    expect(left.location.source.kind).toBe("local");
    expect(String(left.location.path)).toBe("/home/b");
  });
});
