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
import { useToast } from "@/stores/toast";

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
  useToast.setState({ toasts: [] });
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

it.each(["host", "password"] as const)(
  "remote-NEW-1: %s save failure is reported after a successful connection",
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
    // 연결은 성공했으니 대화상자는 닫히되, 저장 실패는 오류 토스트로 남는다(원문은 detail).
    expect(onClose).toHaveBeenCalledTimes(1);
    const errors = useToast.getState().toasts.filter((t) => t.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toMatch(
      failedSave === "host" ? /save host u@box\.lan:22/ : /password for u@box/,
    );
    expect(errors[0]!.message).toMatch(/disk is full/i);
  },
);
