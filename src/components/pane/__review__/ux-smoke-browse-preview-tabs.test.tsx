/** Preview hook with real tab store, mocked IPC. No live app. */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { commands } from "@/types/bindings";
import { activeTab, computeDisplayed, usePanes } from "@/stores/panes";
import { cursorPreviewDep, cursorTarget, usePreviewLoad } from "../PreviewPane";
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "linux" }));
vi.mock("@/types/bindings", () => ({ commands: { fsReadPreview: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("duplicate/close/reopen while preview is loading discards the closed tab response", async () => {
  vi.useFakeTimers();
  const p = usePanes.getState();
  p.restoreLayout({
    activePane: "left",
    panes: {
      left: {
        activeTabIndex: 0,
        tabs: [
          {
            path: "/fixture",
            sortKey: "name",
            sortOrder: "asc",
            showHidden: false,
            viewMode: "details",
          },
        ],
      },
      right: {
        activeTabIndex: 0,
        tabs: [
          {
            path: "/other",
            sortKey: "name",
            sortOrder: "asc",
            showHidden: false,
            viewMode: "details",
          },
        ],
      },
    },
  });
  p.setEntries("left", { source: { kind: "local" }, path: "/fixture" }, [
    {
      name: "old.txt",
      kind: "file",
      size: 1,
      modified_ms: 0,
      permissions: null,
      hidden: false,
    },
    {
      name: "new.txt",
      kind: "file",
      size: 1,
      modified_ms: 0,
      permissions: null,
      hidden: false,
    },
  ]);
  const at = (name: string) =>
    computeDisplayed(activeTab(usePanes.getState(), "left")).findIndex(
      (e) => e.name === name,
    );
  p.setCursor("left", at("old.txt"));
  let finish: (
    r: Awaited<ReturnType<typeof commands.fsReadPreview>>,
  ) => void = () => {};
  vi.mocked(commands.fsReadPreview).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  vi.mocked(commands.fsReadPreview).mockResolvedValue({
    status: "ok",
    data: {
      kind: "text",
      bytes_base64: null,
      mime: null,
      text: "NEW",
      truncated: false,
      total_size: 3,
    },
  });
  const { result } = renderHook(() => {
    usePanes(cursorPreviewDep);
    return usePreviewLoad(cursorTarget());
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  act(() => {
    p.duplicateTab("left", 0);
    p.setCursor("left", at("new.txt"));
    p.closeTab("left", 0);
    p.reopenClosedTab();
  });
  await act(async () => {
    finish({
      status: "ok",
      data: {
        kind: "text",
        bytes_base64: null,
        mime: null,
        text: "STALE",
        truncated: false,
        total_size: 5,
      },
    });
    await vi.advanceTimersByTimeAsync(200);
  });
  // Reopened tab has no listing yet, so a closed tab's preview cannot become ready.
  expect(result.current.phase).toBe("empty");
  act(() => p.closeTab("left", usePanes.getState().panes.left.activeTabIndex));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(result.current.phase).toBe("ready");
  if (result.current.phase === "ready")
    expect(result.current.name).toBe("new.txt");
});

vi.setConfig({ testTimeout: 30000 });
