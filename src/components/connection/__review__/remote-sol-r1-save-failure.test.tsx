/** New R1 gaps; mocked FE tests only, no SSH or user files. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AdHocConnectDialog } from "../AdHocConnectDialog";
import { useConnections } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import { useVault } from "@/stores/vault";

const m = vi.hoisted(() => ({
  connectionOpenAdhoc: vi.fn(),
  connectionClose: vi.fn(),
  savedHostsUpsert: vi.fn(),
  vaultSet: vi.fn(),
  vaultStatus: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

beforeEach(() => {
  Object.values(m).forEach((mock) => mock.mockReset());
  useVault.setState({ exists: true, unlocked: true });
  useSavedHosts.setState({ hosts: [] });
  useConnections.setState({ hosts: [], active: {}, reconnecting: {} });
  m.connectionOpenAdhoc.mockResolvedValue({
    status: "ok",
    data: {
      id: "u@box.lan:22:one",
      alias: "u@box.lan:22",
      host_ip: "10.0.0.2",
      user: "u",
    },
  });
  m.savedHostsUpsert.mockImplementation(async (h: unknown) => ({
    status: "ok",
    data: [h],
  }));
});
afterEach(cleanup);

it.fails.each(["host", "password"] as const)(
  "remote-NEW-1 repro: %s save failure must remain visible after successful connection",
  async (failedSave) => {
    const error = {
      status: "error",
      error: { kind: "Io", message: "disk full" },
    };
    if (failedSave === "host") m.savedHostsUpsert.mockResolvedValue(error);
    else m.vaultSet.mockResolvedValue(error);
    const onClose = vi.fn();
    render(<AdHocConnectDialog open onClose={onClose} onConnected={vi.fn()} />);
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
    if (failedSave === "password")
      fireEvent.click(screen.getByLabelText("dialog.adhoc.savePassword"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    expect(
      failedSave === "host" ? m.savedHostsUpsert : m.vaultSet,
    ).toHaveBeenCalled();
    // Current behavior closes with no error, indistinguishable from successful saving.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("disk full");
  },
);
