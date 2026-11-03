import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import { ConnectionDialog } from "./ConnectionDialog";
import { AdHocConnectDialog } from "./AdHocConnectDialog";
import { useConnections } from "@/stores/connections";
import { useVault } from "@/stores/vault";
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
  savedHostsUpsert: vi.fn(),
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
  m.vaultHas.mockResolvedValue({ status: "ok", data: false });
  useVault.setState({ exists: false, unlocked: false });
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

describe("AdHocConnectDialog saved password (§5)", () => {
  const saved = {
    alias: "box",
    host: "box.lan",
    port: 22,
    user: "u",
    key_path: null,
  };

  beforeEach(() => {
    useVault.setState({ exists: true, unlocked: true });
    m.vaultHas.mockResolvedValue({ status: "ok", data: true });
    m.connectionOpenAdhoc.mockResolvedValue({
      status: "error",
      error: { kind: "AuthFailed" },
    });
  });

  it("does not send the saved password alias once the host is edited", async () => {
    render(
      <AdHocConnectDialog
        open
        onClose={vi.fn()}
        onConnected={vi.fn()}
        prefill={saved}
      />,
    );
    fireEvent.change(screen.getByLabelText("dialog.adhoc.host"), {
      target: { value: "other.lan" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    expect(m.connectionOpenAdhoc).toHaveBeenCalledWith(
      expect.objectContaining({ host: "other.lan", savedPasswordAlias: null }),
    );
  });

  it("sends the alias for the unchanged endpoint even before vaultHas answers", async () => {
    m.vaultHas.mockReturnValue(new Promise(() => {}));
    render(
      <AdHocConnectDialog
        open
        onClose={vi.fn()}
        onConnected={vi.fn()}
        prefill={saved}
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    expect(m.connectionOpenAdhoc).toHaveBeenCalledWith(
      expect.objectContaining({ host: "box.lan", savedPasswordAlias: "box" }),
    );
  });
});

describe("host key prompt pins the endpoint", () => {
  it("locks the address fields while the fingerprint is shown", async () => {
    m.connectionOpenAdhoc.mockResolvedValueOnce({
      status: "error",
      error: {
        kind: "HostKeyUnverified",
        message: {
          host: "a.lan",
          fingerprint: "SHA256:TEST-A",
          changed: false,
          changed_line: null,
        },
      },
    });
    render(
      <AdHocConnectDialog
        open
        onClose={vi.fn()}
        onConnected={vi.fn()}
        prefill={{
          alias: "a",
          host: "a.lan",
          port: 22,
          user: "u",
          key_path: null,
        }}
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    const hostInput = screen.getByLabelText(
      "dialog.adhoc.host",
    ) as HTMLInputElement;
    expect(hostInput.disabled).toBe(true);
    m.connectionOpenAdhoc.mockResolvedValueOnce({
      status: "error",
      error: { kind: "AuthFailed" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.hostKey.trustCta/ }),
      );
    });
    expect(m.connectionOpenAdhoc).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "a.lan", trustHostKey: true }),
    );
  });
});

describe("password handling (§5)", () => {
  it("clears the password field as soon as the call starts and reuses it only for the host-key retry", async () => {
    const first = deferred<unknown>();
    m.connectionOpen.mockReturnValueOnce(first.promise);
    render(
      <ConnectionDialog alias="nas" onClose={vi.fn()} onConnected={vi.fn()} />,
    );
    const pw = screen.getByLabelText(
      "dialog.connection.passwordLabel",
    ) as HTMLInputElement;
    fireEvent.change(pw, { target: { value: "secret" } });
    fireEvent.click(
      screen.getByRole("button", { name: /dialog.connection.connect/ }),
    );
    expect(pw.value).toBe("");
    expect(m.connectionOpen).toHaveBeenLastCalledWith(
      "nas",
      "secret",
      false,
      false,
    );
    await act(async () =>
      first.resolve({
        status: "error",
        error: {
          kind: "HostKeyUnverified",
          message: {
            host: "nas.lan",
            fingerprint: "SHA256:X",
            changed: false,
            changed_line: null,
          },
        },
      }),
    );
    m.connectionOpen.mockResolvedValueOnce({ status: "ok", data: dto });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.hostKey.trustCta/ }),
      );
    });
    expect(m.connectionOpen).toHaveBeenLastCalledWith(
      "nas",
      "secret",
      true,
      false,
    );
  });
});

describe("AdHocConnectDialog keyboard", () => {
  it("submits with Enter from a field", async () => {
    m.connectionOpenAdhoc.mockResolvedValue({
      status: "error",
      error: { kind: "AuthFailed" },
    });
    render(
      <AdHocConnectDialog
        open
        onClose={vi.fn()}
        onConnected={vi.fn()}
        prefill={{
          alias: "box",
          host: "box.lan",
          port: 22,
          user: "u",
          key_path: null,
        }}
      />,
    );
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("dialog.adhoc.password"), {
        key: "Enter",
      });
    });
    expect(m.connectionOpenAdhoc).toHaveBeenCalledTimes(1);
  });
});

describe("pane picker", () => {
  it("exposes the selected pane to assistive tech and defaults to the given pane", () => {
    render(
      <ConnectionDialog
        alias="nas"
        onClose={vi.fn()}
        onConnected={vi.fn()}
        defaultPane="right"
      />,
    );
    const right = screen.getByRole("button", {
      name: "dialog.connection.paneRight",
    });
    const left = screen.getByRole("button", {
      name: "dialog.connection.paneLeft",
    });
    expect(right.getAttribute("aria-pressed")).toBe("true");
    expect(left.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("ad-hoc request identity (round 2)", () => {
  const savedA = {
    alias: "a",
    host: "a.lan",
    port: 22,
    user: "u",
    key_path: null,
  };
  const hostKeyErr = (host: string) => ({
    status: "error",
    error: {
      kind: "HostKeyUnverified",
      message: {
        host,
        fingerprint: `SHA256:${host}`,
        changed: false,
        changed_line: null,
      },
    },
  });

  it("vault unlock during a host key prompt does not refill the form or retarget Trust", async () => {
    useVault.setState({ exists: true, unlocked: false });
    m.connectionOpenAdhoc.mockResolvedValueOnce(hostKeyErr("b.lan"));
    render(
      <AdHocConnectDialog
        open
        onClose={vi.fn()}
        onConnected={vi.fn()}
        prefill={savedA}
      />,
    );
    fireEvent.change(screen.getByLabelText("dialog.adhoc.host"), {
      target: { value: "b.lan" },
    });
    fireEvent.change(screen.getByLabelText("dialog.adhoc.password"), {
      target: { value: "pw-b" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    // 프롬프트 표시 중 잠금 해제 버튼은 막혀 있다.
    expect(
      (
        screen.getByRole("button", {
          name: /dialog.adhoc.unlockVault/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // 다른 경로로 vault 가 열려도(전역 상태) 폼/대상은 그대로.
    await act(async () => useVault.setState({ unlocked: true }));
    expect(
      (screen.getByLabelText("dialog.adhoc.host") as HTMLInputElement).value,
    ).toBe("b.lan");
    m.connectionOpenAdhoc.mockResolvedValueOnce({
      status: "error",
      error: { kind: "AuthFailed" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.hostKey.trustCta/ }),
      );
    });
    expect(m.connectionOpenAdhoc).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: "b.lan",
        password: "pw-b",
        savedPasswordAlias: null,
        trustHostKey: true,
      }),
    );
  });

  it("does not navigate when cancelled while the host is being saved", async () => {
    const save = deferred<unknown>();
    m.savedHostsUpsert.mockReturnValue(save.promise);
    m.connectionOpenAdhoc.mockResolvedValue({
      status: "ok",
      data: { ...dto, id: "u@new.lan:22:1" },
    });
    const onConnected = vi.fn();
    render(
      <AdHocConnectDialog open onClose={vi.fn()} onConnected={onConnected} />,
    );
    fireEvent.change(screen.getByLabelText("dialog.adhoc.host"), {
      target: { value: "new.lan" },
    });
    fireEvent.change(screen.getByLabelText("dialog.adhoc.user"), {
      target: { value: "u" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    await waitFor(() => expect(m.savedHostsUpsert).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: /common.cancel/ }));
    await act(async () => save.resolve({ status: "ok", data: [] }));
    expect(onConnected).not.toHaveBeenCalled();
    expect(m.connectionClose).toHaveBeenCalledWith("u@new.lan:22:1");
  });
});
