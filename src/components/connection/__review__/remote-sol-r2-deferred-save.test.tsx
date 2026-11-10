import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AdHocConnectDialog } from "@/components/connection/AdHocConnectDialog";
import { useVault } from "@/stores/vault";
import { useToast } from "@/stores/toast";
import { useConnections } from "@/stores/connections";
import { useNotices } from "@/stores/notices";

const m = vi.hoisted(() => ({
  connectionOpenAdhoc: vi.fn(),
  savedHostsUpsert: vi.fn(),
  vaultSet: vi.fn(),
  vaultUnlock: vi.fn(),
  vaultStatus: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
afterEach(() => {
  cleanup();
  useToast.getState().clear();
});

it("NEW-1 review: a deferred password save reports failure after unlocking without losing the successful connection", async () => {
  useVault.setState({ exists: true, unlocked: false });
  useToast.getState().clear();
  useNotices.getState().clear();
  useConnections.setState({ active: {}, hosts: [], reconnecting: {} });
  m.connectionOpenAdhoc.mockResolvedValue({
    status: "ok",
    data: {
      id: "u@box.lan:22:new",
      alias: "u@box.lan:22",
      host_ip: "10.0.0.2",
      user: "u",
    },
  });
  m.savedHostsUpsert.mockImplementation(async (h: unknown) => ({
    status: "ok",
    data: [h],
  }));
  m.vaultUnlock.mockResolvedValue({ status: "ok", data: null });
  m.vaultStatus.mockResolvedValue({
    status: "ok",
    data: { exists: true, unlocked: true },
  });
  m.vaultSet.mockResolvedValue({
    status: "error",
    error: { kind: "Io", message: "disk full" },
  });
  const connected = vi.fn();
  render(<AdHocConnectDialog open onClose={vi.fn()} onConnected={connected} />);
  fireEvent.change(screen.getByLabelText("dialog.adhoc.host"), {
    target: { value: "box.lan" },
  });
  fireEvent.change(screen.getByLabelText("dialog.adhoc.user"), {
    target: { value: "u" },
  });
  fireEvent.change(screen.getByLabelText("dialog.adhoc.password"), {
    target: { value: "test-only-password" },
  });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByLabelText("dialog.adhoc.savePassword"));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: /dialog.connection.connect/ }),
    );
  });
  expect(connected).toHaveBeenCalledTimes(1);
  fireEvent.change(
    screen.getByPlaceholderText("dialog.masterPassword.placeholder"),
    { target: { value: "test-only-master" } },
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: /dialog.masterPassword.unlock/ }),
    );
  });
  expect(m.vaultSet).toHaveBeenCalledWith("u@box.lan:22", "test-only-password");
  expect(useConnections.getState().active["u@box.lan:22:new"]?.state.kind).toBe(
    "connected",
  );
  expect(
    useToast
      .getState()
      .toasts.some(
        (t) => t.kind === "error" && /password for u@box/.test(t.message),
      ),
  ).toBe(true);
  expect(
    useNotices.getState().items.some((n) => n.detail?.includes("disk full")),
  ).toBe(true);
});
