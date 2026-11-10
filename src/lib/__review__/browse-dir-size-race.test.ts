import { beforeEach, expect, it, vi } from "vitest";
import { commands, type Entry } from "@/types/bindings";
import { activeTab, computeDisplayed, usePanes } from "@/stores/panes";
import { calcDirSizes } from "@/lib/dirSize";

vi.mock("@/types/bindings", () => ({ commands: { fsDirSize: vi.fn() } }));
const dir: Entry = {
  name: "same-name",
  kind: "dir",
  size: null,
  modified_ms: null,
  permissions: null,
  hidden: false,
};
const loc = (path: string) => ({ source: { kind: "local" as const }, path });

beforeEach(() => {
  vi.clearAllMocks();
  usePanes.getState().setEntries("left", loc("/original"), [dir]);
});

it("browse-09 (F-sol-15): cursor-only size calculation should use the displayed folder after the parent row", async () => {
  const file: Entry = { ...dir, name: "another.txt", kind: "file", size: 7 };
  usePanes.getState().setEntries("left", loc("/original"), [dir, file]);
  const displayed = computeDisplayed(activeTab(usePanes.getState(), "left"));
  const cursor = displayed.findIndex((entry) => entry.name === dir.name);
  expect(cursor).toBe(1);
  usePanes.getState().setCursor("left", cursor);
  vi.mocked(commands.fsDirSize).mockResolvedValue({ status: "ok", data: 5 });
  await calcDirSizes("left");
  expect(commands.fsDirSize).toHaveBeenCalledWith(loc("/original/same-name"));
});

it("browse-09: cursor on the '..' row computes nothing", async () => {
  const displayed = computeDisplayed(activeTab(usePanes.getState(), "left"));
  expect(displayed[0]?.name).toBe("..");
  usePanes.getState().setCursor("left", 0);
  await calcDirSizes("left");
  expect(commands.fsDirSize).not.toHaveBeenCalled();
});

it.fails(
  "browse-20 (F-sol-03): late size response must not attach to same-named child in another folder",
  async () => {
    let resolve!: (result: { status: "ok"; data: number }) => void;
    vi.mocked(commands.fsDirSize).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const pending = calcDirSizes("left", [dir.name]);
    usePanes.getState().setEntries("left", loc("/different"), [dir]);
    resolve({ status: "ok", data: 123456 });
    await pending;
    expect(activeTab(usePanes.getState(), "left").location.path).toBe(
      "/different",
    );
    expect(
      activeTab(usePanes.getState(), "left").dirSizes[dir.name],
    ).toBeUndefined();
  },
);
