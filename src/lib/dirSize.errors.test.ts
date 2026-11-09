import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { commands } from "@/types/bindings";
import { usePanes } from "@/stores/panes";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";
import { calcDirSizes } from "./dirSize";

vi.mock("@/types/bindings", () => ({ commands: { fsDirSize: vi.fn() } }));
afterEach(() => {
  useToast.getState().clear();
  useNotices.getState().clear();
});

it("records folder-size failures as errors with the target name and original detail", async () => {
  await i18n.changeLanguage("en");
  usePanes
    .getState()
    .setEntries("left", { source: { kind: "local" }, path: "/fixture" }, [
      {
        name: "reports",
        kind: "dir",
        size: null,
        modified_ms: null,
        permissions: null,
        hidden: false,
      },
    ]);
  const raw = "permission denied (os error 13)";
  vi.mocked(commands.fsDirSize).mockResolvedValue({
    status: "error",
    error: { kind: "PermissionDenied", message: raw },
  });
  await calcDirSizes("left", ["reports"]);
  expect(useToast.getState().toasts[0]).toMatchObject({
    kind: "error",
    message: expect.stringContaining("reports"),
  });
  expect(useNotices.getState().items[0]?.detail).toContain("/fixture/reports");
  expect(useNotices.getState().items[0]?.detail).toContain(raw);
});
