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
const file = (name: string) => ({ ...dir(name), kind: "file", size: 1 });
const listing: Record<string, unknown[]> = {
  "/home": [dir("a"), dir("b"), dir("slow"), file("x.zip")],
  "/home/a": [file("a.txt")],
  "/home/b": [file("b.txt")],
  "/home/slow": [file("late.txt")],
  "/other": [dir("o")],
  "/other/o": [file("o.txt")],
  "/": [dir("home"), dir("other")],
  "/srv": [dir("app")],
  "/srv/app": [file("main.rs")],
  "/tmp/ex": [dir("inner"), file("in.txt")],
  "/tmp/ex/inner": [file("deep.txt")],
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
        return async () => ({
          status: "ok",
          data: { source: { kind: "local" }, path: "/tmp/ex" },
        });
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
import { useBookmarks } from "@/stores/bookmarks";
import { useCommands } from "@/stores/commands";
import type { Bookmark } from "@/types/bindings";

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
const runCommand = (id: string) =>
  act(() => {
    const c = useCommands.getState().builtins.find((b) => b.id === id);
    if (!c) throw new Error(`no command ${id}`);
    c.action();
  });
const back = () => key({ key: "ArrowLeft", code: "ArrowLeft", altKey: true });

beforeEach(() => {
  cleanup();
  failing.clear();
  listCalls.length = 0;
  watchCalls.length = 0;
  sizeCalls.length = 0;
  clearClosedTabs();
  useToast.getState().clear();
  localStorage.clear();
});

describe("browse-13 변경 이벤트 폭주", () => {
  it("기록: 현재 폴더 하위 파일 200개 생성 이벤트 → 목록 재조회·감시 재설정 횟수", async () => {
    await boot();
    const fire = listeners["fsChangedEvent"];
    expect(fire).toBeDefined();
    act(() => {
      for (let i = 0; i < 200; i++)
        fire!({
          event: "fs-changed-event",
          id: 1,
          payload: { source: { kind: "local" }, path: `/home/new-${i}` },
        });
    });
    await wait(600);
    const lists = listCalls.filter((c) => c === "local:/home").length;
    const watches = watchCalls.filter(([, p]) => p === "/home").length;
    // R2 실행 결과를 보고서에 기록 — 세대 로직이 응답을 버리지 않으므로 전부 나간다
    expect(lists).toBe(400); // 양쪽 패널이 /home → 패널당 200
    expect(watches).toBe(400); // 성공한 새로고침마다 감시를 다시 건다
    expect(tabL().loading).toBe(false);
  });
});

describe("browse-09 커서만 둔 폴더 크기 (Shift+Space)", () => {
  it("browse-09 (R2 재현): 수정일 정렬(기본값)에서 커서 폴더 'new' 대신 다른 항목을 계산한다", async () => {
    await boot("/w", "/home", { sortKey: "mtime", sortOrder: "desc" });
    cursorTo("new"); // 화면: .., new, mid, old, z.txt  / 원본: old, mid, new, z.txt
    runCommand("file.calcSize");
    await wait(80);
    expect(sizeCalls).toEqual(["/w/new"]);
  });

  it("대조: 우클릭 메뉴 경로는 선택을 그 항목으로 바꾸므로 맞는 폴더를 계산한다", async () => {
    await boot("/w", "/home", { sortKey: "mtime", sortOrder: "desc" });
    cursorTo("new");
    act(() => usePanes.getState().setSelected("left", ["new"]));
    runCommand("file.calcSize");
    await wait(80);
    expect(sizeCalls).toEqual(["/w/new"]);
  });
});

describe("C-20 북마크 이동", () => {
  const bm = (path: string): Bookmark =>
    ({
      id: `bm-${path}`,
      name: path,
      location: { source: { kind: "local" }, path },
    }) as unknown as Bookmark;

  it("없는 경로 북마크: 오류 토스트, 지금 폴더·히스토리 유지", async () => {
    await boot();
    failing.add("/gone");
    act(() => useBookmarks.getState().setAll([bm("/gone")]));
    runCommand("bookmark.goto1");
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    expect(tabL().history.stack.map((l) => String(l.path))).toEqual(["/home"]);
    const t = useToast.getState().toasts.at(-1);
    expect(t?.kind).toBe("error");
    expect(t?.message).toMatch(/\/gone/);
  });

  it("북마크 이동은 같은 탭에서, 히스토리에 쌓이고 뒤로 가면 돌아온다", async () => {
    await boot();
    act(() => useBookmarks.getState().setAll([bm("/other")]));
    runCommand("bookmark.goto1");
    await wait(80);
    expect(usePanes.getState().panes.left.tabs).toHaveLength(1);
    expect(String(tabL().location.path)).toBe("/other");
    back();
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
  });

  it("아카이브 안에서 북마크로 나가면 아카이브 문맥이 풀린다", async () => {
    await boot();
    cursorTo("x.zip");
    key({ key: "Enter", code: "Enter" });
    await wait(150);
    expect(tabL().archive?.label).toBe("x.zip");
    act(() => useBookmarks.getState().setAll([bm("/other")]));
    runCommand("bookmark.goto1");
    await wait(80);
    expect(String(tabL().location.path)).toBe("/other");
    expect(tabL().archive).toBeUndefined();
  });
});

describe("C-21 압축 내부 보기 문맥", () => {
  async function openZip() {
    await boot();
    cursorTo("x.zip");
    key({ key: "Enter", code: "Enter" });
    await wait(150);
    expect(String(tabL().location.path)).toBe("/tmp/ex");
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
    expect(String(tabL().location.path)).toBe("/tmp/ex");
    expect(tabL().archive?.label).toBe("x.zip");
    key({ key: "Backspace", code: "Backspace" });
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    expect(tabL().archive).toBeUndefined();
  });

  it("browse-32 (F-opus-201): 아카이브에서 나온 뒤 '뒤로' 가면 문맥 없이 임시 추출 폴더로 들어간다", async () => {
    await openZip();
    key({ key: "Backspace", code: "Backspace" }); // 나가기 → /home
    await wait(80);
    expect(String(tabL().location.path)).toBe("/home");
    back();
    await wait(80);
    // 뒤로 = 임시 폴더 /tmp/ex 로 돌아왔는데 아카이브 문맥이 없다:
    // 브레드크럼에 임시 경로, 위로 = /tmp, "아카이브 갱신" 없음, 탭 제목 = "ex"
    expect(String(tabL().location.path)).toBe("/tmp/ex");
    expect(tabL().archive?.label).toBe("x.zip");
  });

  it("browse-34 (F-opus-202): 아카이브 루트에서 위로 나가면 커서가 아카이브 파일이 아니라 맨 위에 놓인다", async () => {
    await openZip();
    key({ key: "Backspace", code: "Backspace" });
    await wait(80);
    const t = tabL();
    expect(computeDisplayed(t)[t.cursorIndex]?.name).toBe("x.zip");
  });
});
