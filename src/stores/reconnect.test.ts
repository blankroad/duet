import { describe, it, expect, vi, beforeEach } from "vitest";
import { usePanes, type TabState } from "@/stores/panes";
import { useConnections, type ActiveConnection } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import { useVault } from "@/stores/vault";
import type { Location } from "@/types/bindings";

const m = vi.hoisted(() => ({
  connectionOpen: vi.fn(),
  connectionOpenAdhoc: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));

import {
  pruneDeadConnections,
  quickReconnect,
  rebindHostTabs,
  type SshSource,
} from "./reconnect";

const ssh = (connection_id: string, path = "/srv"): Location => ({
  source: { kind: "ssh", connection_id, host_ip: "10.0.0.1", user: "u" },
  path,
});
const local = (path: string): Location => ({ source: { kind: "local" }, path });

function tabsOf(locs: Location[]): TabState[] {
  const base = usePanes.getState().panes.left.tabs[0]!;
  return locs.map((location, i) => ({
    ...base,
    id: `${String(location.path)}#${i}`,
    location,
    history: { stack: [location], index: 0 },
  }));
}

const conn = (
  id: string,
  alias: string,
  kind: ActiveConnection["state"]["kind"],
): ActiveConnection => ({
  id,
  alias,
  host_ip: "10.0.0.1",
  user: "u",
  state:
    kind === "error" ? { kind: "error", message: "x" } : ({ kind } as never),
});

const fresh: SshSource = {
  kind: "ssh",
  connection_id: "nas:new",
  host_ip: "10.0.0.9",
  user: "u",
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  useConnections.setState({ active: {}, hosts: [], reconnecting: {} });
  useSavedHosts.setState({ hosts: [] });
  useVault.setState({ exists: false, unlocked: false });
});

describe("rebindHostTabs", () => {
  it("rebinds every dead tab of the host in both panes, keeping paths", () => {
    useConnections.setState({
      active: {
        "nas:old": conn("nas:old", "nas", "error"),
        "nas:live": conn("nas:live", "nas", "connected"),
        "web:old": conn("web:old", "web", "error"),
      },
    });
    usePanes.setState({
      panes: {
        left: {
          activeTabIndex: 1,
          tabs: tabsOf([
            ssh("nas:old", "/a"),
            local("/tmp"),
            ssh("nas:restored", "/b"),
          ]),
        },
        right: {
          activeTabIndex: 0,
          tabs: tabsOf([
            ssh("nas:old", "/c"),
            ssh("nas:live", "/d"),
            ssh("web:old", "/e"),
          ]),
        },
      },
    });

    const r = rebindHostTabs("nas", fresh);

    const { left, right } = usePanes.getState().panes;
    const idOf = (t: TabState) =>
      t.location.source.kind === "ssh"
        ? t.location.source.connection_id
        : "local";
    expect(left.tabs.map(idOf)).toEqual(["nas:new", "local", "nas:new"]);
    // 살아있는 다른 세션·다른 호스트는 그대로
    expect(right.tabs.map(idOf)).toEqual(["nas:new", "nas:live", "web:old"]);
    expect(left.tabs.map((t) => t.location.path)).toEqual(["/a", "/tmp", "/b"]);
    expect(right.tabs[0]!.history.stack[0]!.source).toEqual(fresh);
    // 왼쪽 활성 탭은 로컬이라 새로 읽을 필요 없음, 오른쪽은 있음
    expect(r).toEqual({ panes: ["right"], tabs: 3 });
  });

  it("leaves a host that the backend is still reconnecting alone", () => {
    useConnections.setState({
      active: { "nas:old": conn("nas:old", "nas", "connecting") },
    });
    usePanes.setState({
      panes: {
        left: { activeTabIndex: 0, tabs: tabsOf([ssh("nas:old")]) },
        right: { activeTabIndex: 0, tabs: tabsOf([local("/")]) },
      },
    });
    expect(rebindHostTabs("nas", fresh).tabs).toBe(0);
  });
});

describe("pruneDeadConnections", () => {
  it("drops dead entries of the alias that no tab uses", () => {
    useConnections.setState({
      active: {
        "nas:old": conn("nas:old", "nas", "error"),
        "nas:kept": conn("nas:kept", "nas", "error"),
        "nas:new": conn("nas:new", "nas", "connected"),
      },
    });
    usePanes.setState({
      panes: {
        left: { activeTabIndex: 0, tabs: tabsOf([ssh("nas:kept")]) },
        right: { activeTabIndex: 0, tabs: tabsOf([local("/")]) },
      },
    });
    pruneDeadConnections("nas");
    expect(Object.keys(useConnections.getState().active).sort()).toEqual([
      "nas:kept",
      "nas:new",
    ]);
  });
});

describe("quickReconnect", () => {
  const dto = { id: "x:1", alias: "x", host_ip: "1.1.1.1", user: "u" };

  it("reconnects a config host without trusting new host keys", async () => {
    useConnections.setState({
      hosts: [
        {
          alias: "nas",
          hostname: "n",
          port: 22,
          user: "u",
          has_proxy_jump: false,
        },
      ],
    });
    m.connectionOpen.mockResolvedValue({ status: "ok", data: dto });
    expect(await quickReconnect("nas")).toEqual({ kind: "ok", dto });
    expect(m.connectionOpen).toHaveBeenCalledWith("nas", null, false, false);
  });

  it("uses the saved vault password by alias only (no plaintext) when unlocked", async () => {
    useSavedHosts.setState({
      hosts: [
        {
          alias: "box",
          host: "box.lan",
          port: 2222,
          user: "u",
          key_path: null,
        },
      ],
    });
    useVault.setState({ exists: true, unlocked: true });
    m.connectionOpenAdhoc.mockResolvedValue({ status: "ok", data: dto });
    await quickReconnect("u@box.lan:2222");
    expect(m.connectionOpenAdhoc).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "box.lan",
        port: 2222,
        password: null,
        savedPasswordAlias: "box",
        trustHostKey: false,
        replaceChangedHostKey: false,
      }),
    );
  });

  it("goes straight to the dialog when the vault is locked and there is no key", async () => {
    useSavedHosts.setState({
      hosts: [
        { alias: "box", host: "box.lan", port: 22, user: "u", key_path: null },
      ],
    });
    useVault.setState({ exists: true, unlocked: false });
    expect(await quickReconnect("box")).toEqual({
      kind: "dialog",
      error: null,
    });
    expect(m.connectionOpenAdhoc).not.toHaveBeenCalled();
  });

  it("asks a human for auth / host key problems, not for network ones", async () => {
    useConnections.setState({
      hosts: [
        {
          alias: "nas",
          hostname: "n",
          port: 22,
          user: "u",
          has_proxy_jump: false,
        },
      ],
    });
    m.connectionOpen.mockResolvedValueOnce({
      status: "error",
      error: { kind: "AuthFailed" },
    });
    expect((await quickReconnect("nas")).kind).toBe("dialog");
    m.connectionOpen.mockResolvedValueOnce({
      status: "error",
      error: { kind: "ConnectionFailed", message: "refused" },
    });
    expect((await quickReconnect("nas")).kind).toBe("failed");
  });
});
