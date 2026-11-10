/** Regression FE smoke with mocked Tauri commands; no live app or filesystem. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, Location } from "@/types/bindings";
const ipc = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: { fsExtractPlanBatch: ipc.plan, fsExtractExecute: ipc.execute },
}));
import { buildEntryMenu } from "@/lib/entryMenu";
import { triggerExtractToFolders } from "@/lib/extractActions";
import { usePanes } from "@/stores/panes";
import { isSeparator, type MenuItem } from "@/stores/contextMenu";
import i18n from "@/i18n";
const location: Location = { source: { kind: "local" }, path: "/fixture" };
const entries: Entry[] = ["a.zip", "b.tar.gz"].map((name) => ({
  name,
  kind: "file",
  size: 10,
  modified_ms: null,
  permissions: null,
  hidden: false,
}));
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  usePanes.setState({ activePane: "left" });
  usePanes.getState().setEntries("left", location, entries);
  usePanes.getState().selectAll("left");
});
describe("archive regression (mocked FE, not live)", () => {
  it("single and multiple archives expose distinct here and folder actions", () => {
    const menu = (selectedCount: number) =>
      buildEntryMenu({
        paneId: "left",
        entry: entries[0]!,
        location,
        selectedCount,
        onActivate: vi.fn(),
        onOpenInOtherPane: vi.fn(),
      }).filter((e): e is MenuItem => !isSeparator(e));
    expect(menu(1).find((e) => e.id === "extract-here")?.label).toBe(
      "Extract here",
    );
    expect(menu(1).find((e) => e.id === "extract")?.label).toBe(
      i18n.t("menu.extractToFolder"),
    );
    expect(menu(2).map((e) => e.id)).toEqual(
      expect.arrayContaining(["extract", "extract-here"]),
    );
    expect(menu(2).find((e) => e.id === "extract")?.label).toBe(
      i18n.t("menu.extractEach", { count: 2 }),
    );
  });
  it("two selected archives are planned and dispatched instead of extractSelectOne", async () => {
    const plan = (name: string) => ({
      source: location.source,
      archive_dir: location,
      archive_name: name,
      format: name.endsWith("zip") ? "zip" : "tar_gz",
      dest_dir: name,
      conflict: false,
      keep_both: true,
    });
    ipc.plan.mockResolvedValue({
      status: "ok",
      data: entries.map((e) => ({
        archive: { location, name: e.name },
        plan: plan(e.name),
        error: null,
      })),
    });
    ipc.execute
      .mockResolvedValueOnce({ status: "ok", data: "one" })
      .mockResolvedValueOnce({ status: "ok", data: "two" });
    const toast = vi.fn();
    await triggerExtractToFolders(vi.fn(), toast);
    expect(ipc.plan).toHaveBeenCalledTimes(1);
    expect(ipc.plan.mock.calls[0]?.[0]).toHaveLength(2);
    expect(ipc.execute).toHaveBeenCalledTimes(2);
    expect(toast).not.toHaveBeenCalled();
  });
});
