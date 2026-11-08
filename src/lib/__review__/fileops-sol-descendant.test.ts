import { afterEach, expect, it, vi } from "vitest";
import type { EntryRef, Location } from "@/types/bindings";
import { commands } from "@/types/bindings";
import { clipPaste } from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: { fsCopyPlan: vi.fn(), fsMovePlan: vi.fn() },
}));
const parent: Location = { source: { kind: "local" }, path: "/fixture" };
const item: EntryRef = { location: parent, name: "a" };
const dst = (path: string): Location => ({ ...parent, path });
afterEach(() => {
  useClipboard.getState().clear();
  vi.clearAllMocks();
});
it("blocks clipboard paste directly into the source folder", async () => {
  useClipboard.getState().set([item], "copy");
  await clipPaste(vi.fn(), vi.fn(), dst("/fixture/a"));
  expect(commands.fsCopyPlan).not.toHaveBeenCalled();
});
it.fails("fileops-04: clipboard paste into a descendant must stop before the backend", async () => {
  vi.mocked(commands.fsCopyPlan).mockResolvedValue({
    status: "error", error: { kind: "Io", message: "review sentinel" },
  });
  useClipboard.getState().set([item], "copy");
  await clipPaste(vi.fn(), vi.fn(), dst("/fixture/a/b/c"));
  expect(commands.fsCopyPlan).not.toHaveBeenCalled();
});
it.fails("fileops-04: cut-paste into a descendant must stop before the backend", async () => {
  vi.mocked(commands.fsMovePlan).mockResolvedValue({
    status: "error", error: { kind: "Io", message: "review sentinel" },
  });
  useClipboard.getState().set([item], "move");
  await clipPaste(vi.fn(), vi.fn(), dst("/fixture/a/b/c"));
  expect(commands.fsMovePlan).not.toHaveBeenCalled();
});
