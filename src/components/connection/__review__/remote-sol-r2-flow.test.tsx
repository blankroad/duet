/** R2 independent tests: save/edit followed by quickReconnect; connection id consumers. */
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AdHocConnectDialog } from "../AdHocConnectDialog";
import { useSavedHosts } from "@/stores/savedHosts";
import { useVault } from "@/stores/vault";
import { useConnections } from "@/stores/connections";
import { usePanes } from "@/stores/panes";
import { useClipboard } from "@/stores/clipboard";
import { useShelf } from "@/stores/shelf";
import {
  quickReconnect,
  rebindHostTabs,
  pruneDeadConnections,
} from "@/stores/reconnect";
import type { SavedHost, EntryRef, Location } from "@/types/bindings";

const m = vi.hoisted(() => ({
  connectionOpen: vi.fn(),
  connectionOpenAdhoc: vi.fn(),
  connectionClose: vi.fn(),
  vaultHas: vi.fn(),
  vaultStatus: vi.fn(),
  vaultSet: vi.fn(),
  vaultRemove: vi.fn(),
  savedHostsUpsert: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const original: SavedHost = {
  alias: "box",
  host: "old.internal",
  port: 22,
  user: "duet",
  key_path: null,
};
beforeEach(() => {
  Object.values(m).forEach((mock) => mock.mockReset());
  m.connectionClose.mockResolvedValue({ status: "ok", data: null });
  m.vaultHas.mockResolvedValue({ status: "ok", data: true });
  m.savedHostsUpsert.mockImplementation(async (h: SavedHost) => ({
    status: "ok",
    data: [h],
  }));
  useVault.setState({ exists: true, unlocked: true });
  useSavedHosts.setState({ hosts: [original] });
  useConnections.setState({ active: {}, hosts: [], reconnecting: {} });
  useClipboard.getState().clear();
  useShelf.getState().clear();
});

it.fails(
  "remote-04: editing then saving must not reuse the previous endpoint secret through quickReconnect",
  async () => {
    m.connectionOpenAdhoc.mockResolvedValueOnce({
      status: "ok",
      data: {
        id: "duet@new.internal:22:one",
        alias: "duet@new.internal:22",
        host_ip: "10.0.0.2",
        user: "duet",
      },
    });
    const dialog = render(
      <AdHocConnectDialog
        open
        prefill={original}
        onClose={vi.fn()}
        onConnected={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("dialog.adhoc.host"), {
      target: { value: "new.internal" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /dialog.connection.connect/ }),
      );
    });
    expect(m.connectionOpenAdhoc.mock.calls[0]?.[0]).toMatchObject({
      host: "new.internal",
      savedPasswordAlias: null,
    });
    expect(useSavedHosts.getState().hosts[0]).toMatchObject({
      alias: "box",
      host: "new.internal",
    });
    expect(m.vaultSet).not.toHaveBeenCalled();
    expect(m.vaultRemove).not.toHaveBeenCalled();
    dialog.unmount();
    m.connectionOpenAdhoc.mockClear();
    m.connectionOpenAdhoc.mockResolvedValue({
      status: "error",
      error: { kind: "AuthFailed" },
    });
    await quickReconnect("box");
    const retry = m.connectionOpenAdhoc.mock.calls[0]?.[0] as {
      host: string;
      savedPasswordAlias: string | null;
    };
    console.info("remote-04 independent reconnect payload", retry);
    expect(retry.host).toBe("new.internal");
    expect(retry.savedPasswordAlias).toBeNull();
  },
);

it.fails(
  "remote-10: successful quick reconnect must refresh references beyond tabs",
  async () => {
    const old: Location = {
      source: {
        kind: "ssh",
        connection_id: "nas:old",
        host_ip: "10.0.0.1",
        user: "duet",
      },
      path: "/data",
    };
    const ref: EntryRef = { location: old, name: "report" };
    const state = usePanes.getState();
    const tab = state.panes.left.tabs[0]!;
    usePanes.setState({
      panes: {
        ...state.panes,
        left: {
          activeTabIndex: 0,
          tabs: [
            { ...tab, location: old, history: { stack: [old], index: 0 } },
          ],
        },
      },
    });
    useConnections.setState({
      hosts: [
        {
          alias: "nas",
          hostname: "nas.internal",
          user: "duet",
          port: 22,
          has_proxy_jump: false,
        },
      ],
      active: {
        "nas:old": {
          id: "nas:old",
          alias: "nas",
          host_ip: "10.0.0.1",
          user: "duet",
          state: { kind: "error", message: "disconnected" },
        },
      },
    });
    useClipboard.getState().set([ref], "move");
    useShelf.getState().add([ref]);
    m.connectionOpen.mockResolvedValue({
      status: "ok",
      data: { id: "nas:new", alias: "nas", host_ip: "10.0.0.1", user: "duet" },
    });
    const result = await quickReconnect("nas");
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("reconnect precondition failed");
    const fresh = {
      kind: "ssh" as const,
      connection_id: result.dto.id,
      host_ip: result.dto.host_ip,
      user: result.dto.user,
    };
    useConnections
      .getState()
      .upsertActive({ ...result.dto, state: { kind: "connected" } });
    rebindHostTabs("nas", fresh);
    pruneDeadConnections("nas");
    expect(usePanes.getState().panes.left.tabs[0]!.location.source).toEqual(
      fresh,
    );
    const refs = [
      useClipboard.getState().entry!.targets[0]!,
      useShelf.getState().sections.flatMap((s) => s.items)[0]!,
    ];
    const ids = refs.map((entry) =>
      entry.location.source.kind === "ssh"
        ? entry.location.source.connection_id
        : "local",
    );
    console.info("remote-10 independent clipboard/shelf ids", ids);
    expect(ids).toEqual(["nas:new", "nas:new"]);
  },
);
