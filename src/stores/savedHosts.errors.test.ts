import { afterEach, expect, it, vi } from "vitest";
import { commands } from "@/types/bindings";
import { removeSavedHost } from "./savedHosts";
import { useToast } from "./toast";
import { useNotices } from "./notices";

vi.mock("@/types/bindings", () => ({
  commands: { savedHostsRemove: vi.fn() },
}));
afterEach(() => {
  useToast.getState().clear();
  useNotices.getState().clear();
});

it("keeps the backend original in notice detail when removing a saved host fails", async () => {
  const raw = "permission denied: /config/saved-hosts.json (os error 13)";
  vi.mocked(commands.savedHostsRemove).mockResolvedValue({
    status: "error",
    error: { kind: "PermissionDenied", message: raw },
  });
  await removeSavedHost("demo");
  expect(useToast.getState().toasts[0]?.kind).toBe("error");
  expect(useNotices.getState().items[0]?.detail).toContain(raw);
});
