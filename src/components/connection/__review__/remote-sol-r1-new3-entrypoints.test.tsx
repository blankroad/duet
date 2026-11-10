import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, renderHook } from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";
import { useConnections, isReconnecting } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import { useHostNicknames } from "@/stores/hostNicknames";
import { useSidebarFilter } from "@/stores/sidebarFilter";
import { useUI } from "@/stores/ui";
import { useDynamicCommands } from "@/lib/dynamicCommands";
import { useCommands } from "@/stores/commands";

vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {},
    {
      get: () => vi.fn(async () => ({ status: "ok", data: [] })),
    },
  ),
}));

const host = (alias: string) => ({
  alias,
  hostname: "example.test",
  port: 22,
  user: "u",
  has_proxy_jump: false,
});
const noop = () => {};

beforeEach(() => {
  useConnections.setState({ hosts: [], active: {}, reconnecting: {} });
  useSavedHosts.setState({ hosts: [] });
  useHostNicknames.setState({ byAlias: {} });
  useUI.setState({ sidebarOpen: true, collapsed: {} });
  useSidebarFilter.setState({ q: "" });
});
afterEach(cleanup);

it("NEW-3 review: registry can set/clear inherited names and aggregate their state", () => {
  const aliases = ["constructor", "toString", "__proto__"];
  for (const alias of aliases) {
    useConnections.getState().setReconnecting(alias, true);
    expect(isReconnecting(useConnections.getState().reconnecting, alias)).toBe(
      true,
    );
    useConnections.getState().upsertActive({
      id: `${alias}:test`,
      alias,
      host_ip: "10.0.0.2",
      user: "u",
      state: { kind: "connected" },
    });
  }
  for (const alias of aliases) {
    expect(useConnections.getState().stateByAlias()[alias]).toEqual({
      kind: "connected",
    });
    useConnections.getState().setReconnecting(alias, false);
    expect(isReconnecting(useConnections.getState().reconnecting, alias)).toBe(
      false,
    );
  }
});

it.each(["config", "saved"])(
  "remote-NEW-3 review: filtering a %s host named __proto__ must not crash Sidebar",
  (kind) => {
    if (kind === "config")
      useConnections.setState({ hosts: [host("__proto__")] });
    else
      useSavedHosts.setState({
        hosts: [
          {
            alias: "__proto__",
            host: "example.test",
            port: 22,
            user: "u",
            key_path: null,
          },
        ],
      });
    useSidebarFilter.setState({ q: "proto" });
    // Capture the actual exception so expected-failure output cannot hide an unrelated assertion.
    const errors = vi.spyOn(console, "error").mockImplementation(noop);
    let observed: string | null = null;
    try {
      render(
        <Sidebar
          onHostActivate={noop}
          onAdHocOpen={noop}
          onSavedActivate={noop}
          onOpenLocation={noop}
          onOpenHostPath={noop}
          onAddBookmark={noop}
          onTrashActivate={noop}
          onEject={noop}
        />,
      );
    } catch (e) {
      observed = String(e);
    } finally {
      errors.mockRestore();
    }
    expect(observed).toBeNull();
  },
);

it("remote-NEW-3 review: palette uses literal constructor alias when nickname map is empty", () => {
  useConnections.setState({ hosts: [host("constructor")] });
  renderHook(() =>
    useDynamicCommands({
      onSavedActivate: noop,
      onHostActivate: noop,
      onBookmarkActivate: noop,
      onFavoriteActivate: noop,
      onAliasExecute: noop,
    }),
  );
  expect(
    useCommands
      .getState()
      .dynamic.find((c) => c.id === "host.connectConfig:constructor")?.label,
  ).toBe("Connect: constructor");
});
