import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConnectionDialog } from "./ConnectionDialog";
import { AdHocConnectDialog } from "./AdHocConnectDialog";
import { useConnections } from "@/stores/connections";
import type { ConnectionDto } from "@/types/bindings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

const m = vi.hoisted(() => ({
  connectionOpen: vi.fn(),
  connectionOpenAdhoc: vi.fn(),
  connectionClose: vi.fn(),
  vaultHas: vi.fn(),
  vaultStatus: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));

const dto: ConnectionDto = {
  id: "nas:1",
  alias: "nas",
  host_ip: "10.0.0.2",
  user: "u",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.connectionClose.mockResolvedValue({ status: "ok", data: null });
  useConnections.setState({
    active: {},
    reconnecting: {},
    hosts: [
      {
        alias: "nas",
        hostname: "nas.lan",
        port: 22,
        user: "u",
        has_proxy_jump: false,
      },
    ],
  });
});

describe("ConnectionDialog request lifecycle", () => {
  it("ignores a success that arrives after cancel and closes that session", async () => {
    const d = deferred<unknown>();
    m.connectionOpen.mockReturnValue(d.promise);
    const onConnected = vi.fn();
    const onClose = vi.fn();
    render(
      <ConnectionDialog
        alias="nas"
        onClose={onClose}
        onConnected={onConnected}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /dialog.connection.connect/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /common.cancel/ }));
    expect(onClose).toHaveBeenCalled();
    await act(async () => d.resolve({ status: "ok", data: dto }));
    expect(onConnected).not.toHaveBeenCalled();
    expect(m.connectionClose).toHaveBeenCalledWith("nas:1");
  });

  it("shows an error instead of hanging when the IPC call rejects", async () => {
    m.connectionOpen.mockRejectedValue(new Error("ipc down"));
    render(
      <ConnectionDialog alias="nas" onClose={vi.fn()} onConnected={vi.fn()} />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    expect(screen.getByRole("alert").textContent).toContain("ipc down");
    expect(
      screen.getByRole("button", { name: /dialog.connection.connect/ }),
    ).toBeTruthy();
  });
});

describe("AdHocConnectDialog request lifecycle", () => {
  it("ignores a success that arrives after cancel", async () => {
    const d = deferred<unknown>();
    m.connectionOpenAdhoc.mockReturnValue(d.promise);
    const onConnected = vi.fn();
    render(
      <AdHocConnectDialog
        open
        onClose={vi.fn()}
        onConnected={onConnected}
        prefill={{
          alias: "box",
          host: "box.lan",
          port: 22,
          user: "u",
          key_path: null,
        }}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: /dialog.connection.connect/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /common.cancel/ }));
    await act(async () =>
      d.resolve({ status: "ok", data: { ...dto, id: "u@box.lan:22:1" } }),
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect(m.connectionClose).toHaveBeenCalledWith("u@box.lan:22:1");
  });
});
