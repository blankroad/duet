import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EntryGrid } from "@/components/pane/EntryGrid";
import { usePanes } from "@/stores/panes";
import { useAppSettings } from "@/stores/settings";
import type { Entry } from "@/types/bindings";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/hooks/useEntryDrag", () => ({ useEntryDrag: () => vi.fn() }));
vi.mock("@/hooks/useMarquee", () => ({
  useMarquee: () => ({ marquee: null, onContainerMouseDown: vi.fn() }),
}));
vi.mock("@/hooks/useCutNames", () => ({
  useCutNames: () => new Set<string>(),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    measure: vi.fn(),
    scrollToIndex: vi.fn(),
    getTotalSize: () => 100,
    getVirtualItems: () => [{ key: 0, index: 0, start: 0, size: 100 }],
  }),
}));
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  usePanes
    .getState()
    .setEntries("left", { source: { kind: "local" }, path: "/fixture" }, []);
  useAppSettings.getState().setShowThumbnails(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const entry: Entry = {
  name: "photo.png",
  kind: "file",
  size: 100,
  modified_ms: 1000,
  permissions: null,
  hidden: false,
};
const callbacks = {
  onCursorMove: vi.fn(),
  onActivate: vi.fn(),
  onColumns: vi.fn(),
  onEntryContextMenu: vi.fn(),
  onEmptyContextMenu: vi.fn(),
  onRenamed: vi.fn(),
};
const grid = (file: Entry) => (
  <EntryGrid
    id="left"
    entries={[file]}
    mode="grid"
    cursorIndex={-1}
    selected={new Set()}
    {...callbacks}
  />
);

it("browse-16 (F-sol-06): changed image metadata should invalidate the rendered thumbnail URL", () => {
  const view = render(grid(entry));
  const before = view.container.querySelector("img")?.getAttribute("src");
  expect(before).toBeTruthy();
  view.rerender(grid({ ...entry, size: 200, modified_ms: 2000 }));
  const after = view.container.querySelector("img")?.getAttribute("src");
  expect(after).not.toBe(before);
});

it("browse-16: a failed thumbnail is retried once the file changes", () => {
  const view = render(grid(entry));
  fireEvent.error(view.container.querySelector("img")!);
  expect(view.container.querySelector("img")).toBeNull();
  view.rerender(grid(entry));
  expect(view.container.querySelector("img")).toBeNull();
  view.rerender(grid({ ...entry, size: 200, modified_ms: 2000 }));
  expect(view.container.querySelector("img")).not.toBeNull();
});

it("review-r1 browse-16 failure in one folder must not suppress a different file with identical metadata", () => {
  const view = render(grid(entry));
  fireEvent.error(view.container.querySelector("img")!);
  expect(view.container.querySelector("img")).toBeNull();
  act(() => {
    usePanes
      .getState()
      .setEntries(
        "left",
        { source: { kind: "local" }, path: "/different-fixture" },
        [{ ...entry }],
      );
  });
  // Virtual row key and basename stay the same; this is a new file/thumbnail URL.
  view.rerender(grid({ ...entry }));
  expect(view.container.querySelector("img")).not.toBeNull();
});
