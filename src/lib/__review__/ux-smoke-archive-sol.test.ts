/** Baseline FE smoke with mocked Tauri commands; no live app or filesystem. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, Location } from "@/types/bindings";
const ipc = vi.hoisted(() => ({ plan: vi.fn(), execute: vi.fn() }));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: { fsExtractPlan: ipc.plan, fsExtractExecute: ipc.execute },
}));
import { buildEntryMenu } from "@/lib/entryMenu";
import { triggerExtract } from "@/lib/fileActions";
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
describe("archive baseline (mocked FE, not live)", () => {
  it("single archive says Extract here; multi-selection hides extract", () => {
    const menu = (selectedCount: number) =>
      buildEntryMenu({
        paneId: "left",
        entry: entries[0]!,
        location,
        selectedCount,
        onActivate: vi.fn(),
        onOpenInOtherPane: vi.fn(),
      }).filter((e): e is MenuItem => !isSeparator(e));
    expect(menu(1).find((e) => e.id === "extract")?.label).toBe("Extract here");
    expect(menu(2).map((e) => e.id)).not.toContain("extract");
  });
  it("triggerExtract rejects two selected archives with extractSelectOne before IPC", async () => {
    const toast = vi.fn();
    await triggerExtract(toast);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(i18n.t("toast.extractSelectOne"));
    expect(ipc.plan).not.toHaveBeenCalled();
    expect(ipc.execute).not.toHaveBeenCalled();
  });
});
