import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands, type ComparePlan, type Location } from "@/types/bindings";
import { triggerCompare } from "@/lib/fileActions";
import { usePanes } from "@/stores/panes";
import type { DialogState } from "@/stores/ui-dialogs";
import { CompareScanningDialog } from "@/components/dialogs/CompareScanningDialog";
import "@/i18n";

vi.mock("@/types/bindings", () => ({
  commands: {
    settingsGet: vi.fn(),
    fsCompareDirs: vi.fn(),
    fsCompareCancel: vi.fn(),
  },
  events: {
    compareProgressEvent: {
      listen: vi.fn().mockResolvedValue(() => {}),
    },
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const left: Location = { source: { kind: "local" }, path: "/fixture/L" };
const right: Location = { source: { kind: "local" }, path: "/fixture/R" };
const plan: ComparePlan = {
  left,
  right,
  entries: [],
  left_only: 0,
  right_only: 0,
  differ: 0,
  same: 0,
  truncated: false,
  strategy: { kind: "local_to_local" },
  moves: [],
};
const settingsError = {
  status: "error",
  error: { kind: "Io", message: "fixture" },
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(commands.settingsGet).mockReset().mockResolvedValue(settingsError);
  vi.mocked(commands.fsCompareDirs)
    .mockReset()
    .mockResolvedValue({ status: "ok", data: plan });
  vi.mocked(commands.fsCompareCancel)
    .mockReset()
    .mockResolvedValue({ status: "ok", data: null });
  usePanes.setState((s) => ({
    activePane: "left",
    panes: {
      left: {
        ...s.panes.left,
        activeTabIndex: 0,
        tabs: [
          {
            ...s.panes.left.tabs[0]!,
            location: left,
            entries: [],
            selected: new Set<string>(),
            cursorIndex: -1,
          },
        ],
      },
      right: {
        ...s.panes.right,
        activeTabIndex: 0,
        tabs: [
          {
            ...s.panes.right.tabs[0]!,
            location: right,
            entries: [],
            selected: new Set<string>(),
            cursorIndex: -1,
          },
        ],
      },
    },
  }));
});
afterEach(cleanup);

it.fails(
  "SC-43a: Esc during settings must prevent the later comparison from starting",
  async () => {
    const settings =
      deferred<Awaited<ReturnType<typeof commands.settingsGet>>>();
    vi.mocked(commands.settingsGet).mockReturnValueOnce(settings.promise);
    let dialog: DialogState = { kind: "none" };
    const open = vi.fn((value: DialogState) => {
      dialog = value;
    });
    const work = triggerCompare(open, vi.fn());
    expect(dialog.kind).toBe("compare-scanning");
    await act(async () => {
      render(createElement(CompareScanningDialog));
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(commands.fsCompareCancel).toHaveBeenCalled());
    expect(commands.fsCompareDirs).not.toHaveBeenCalled();
    settings.resolve(settingsError);
    await work;
    // ActiveCompare has not rotated yet when the real cancel command is called.
    expect(commands.fsCompareDirs).not.toHaveBeenCalled();
  },
);

it.fails(
  "SC-43b: cancelled A must not close the newer B scanning dialog",
  async () => {
    const a = deferred<Awaited<ReturnType<typeof commands.fsCompareDirs>>>();
    const b = deferred<Awaited<ReturnType<typeof commands.fsCompareDirs>>>();
    vi.mocked(commands.fsCompareDirs)
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    let dialog: DialogState = { kind: "none" };
    const open = vi.fn((value: DialogState) => {
      dialog = value;
    });
    const workA = triggerCompare(open, vi.fn());
    await waitFor(() =>
      expect(commands.fsCompareDirs).toHaveBeenCalledTimes(1),
    );
    const workB = triggerCompare(open, vi.fn());
    await waitFor(() =>
      expect(commands.fsCompareDirs).toHaveBeenCalledTimes(2),
    );
    expect(dialog.kind).toBe("compare-scanning");
    a.resolve({ status: "error", error: { kind: "Cancelled" } });
    try {
      await workA;
      expect(dialog.kind).toBe("compare-scanning");
    } finally {
      b.resolve({ status: "ok", data: plan });
      await workB;
    }
  },
);
