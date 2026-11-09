import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TopBar } from "@/components/TopBar";
import { Toast } from "@/components/Toast";
import { NoticeBadge } from "@/components/NoticeBadge";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";
import { initSessionPersist } from "@/stores/session";
import { usePanes } from "@/stores/panes";
import i18n from "@/i18n";

const api = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: api.close,
    isMaximized: async () => false,
    onResized: async () => () => {},
  }),
}));
vi.mock("@/components/AppLauncherStrip", () => ({
  AppLauncherStrip: () => null,
}));
vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {},
    { get: () => async () => ({ status: "ok", data: [] }) },
  ),
  events: {},
}));

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers();
  api.close.mockClear();
  useToast.getState().clear();
  useNotices.getState().clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.fails(
  "browse-26: the actual title-bar close action flushes the pending session",
  async () => {
    const memory = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    });
    initSessionPersist();
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/r2-before-close",
      }),
    );
    act(() => vi.advanceTimersByTime(500));
    const saved = memory.get("duet.session.v1");
    expect(saved).toContain("/r2-before-close");
    act(() =>
      usePanes.getState().openTab("left", {
        source: { kind: "local" },
        path: "/r2-unsaved-last-tab",
      }),
    );
    render(<TopBar />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.close).toHaveBeenCalledOnce();
    expect(memory.get("duet.session.v1")).toContain("/r2-unsaved-last-tab");
  },
);

it("browse-31: hovering a long error keeps it visible past its initial deadline", () => {
  act(() => useToast.getState().show("R2 error that needs reading", "error"));
  render(<Toast />);
  act(() => vi.advanceTimersByTime(7000));
  fireEvent.mouseEnter(screen.getByRole("alert"));
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.queryByRole("alert")).not.toBeNull();
});

it("browse-30/31: error history survives timeout and explicitly provided detail is readable", () => {
  act(() =>
    useToast.getState().show("Friendly error", "error", {
      detail: "R2 backend original: denied /test/file",
    }),
  );
  render(<NoticeBadge />);
  act(() => vi.advanceTimersByTime(8000));
  expect(useToast.getState().toasts).toHaveLength(0);
  expect(useNotices.getState().items).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /notification/i }));
  expect(
    screen.getByText("R2 backend original: denied /test/file"),
  ).toBeTruthy();
});
