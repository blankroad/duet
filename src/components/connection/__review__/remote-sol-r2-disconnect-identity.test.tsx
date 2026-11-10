import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Sidebar } from "@/components/Sidebar";
import { useConnections } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import { useUI } from "@/stores/ui";
import { useSidebarFilter } from "@/stores/sidebarFilter";
import { useHostGroups } from "@/stores/sidebarGroups";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useBookmarks } from "@/stores/bookmarks";
import { useRecents } from "@/stores/recents";
import { useTagFilter } from "@/stores/tagFilter";
import { useContextMenu, isSeparator } from "@/stores/contextMenu";
import type { ActiveConnection } from "@/stores/connections";

const m = vi.hoisted(() => ({ close: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {},
    {
      get: (_, key) =>
        key === "connectionClose"
          ? m.close
          : vi.fn(async () => ({ status: "ok", data: [] })),
    },
  ),
}));
const noop = () => {};
const canonical = "u@box.lan:22";
const conn = (
  id: string,
  alias: string,
  kind: "connected" | "connecting",
  user = "u",
): ActiveConnection => ({
  id,
  alias,
  user,
  host_ip: user === "u" ? "10.0.0.2" : "10.9.9.9",
  state: { kind },
});

beforeEach(() => {
  m.close.mockReset().mockResolvedValue({ status: "ok", data: null });
  useUI.setState({ sidebarOpen: true, collapsed: {} });
  useSidebarFilter.setState({ q: "" });
  useTagFilter.setState({ active: [] });
  useHostGroups.setState({ groups: [] });
  useHostFavorites.setState({ items: [] });
  useBookmarks.setState({ items: [] });
  useRecents.setState({ items: [] });
  useConnections.setState({ hosts: [], active: {}, reconnecting: {} });
  useSavedHosts.setState({
    hosts: [
      {
        alias: "saved-box",
        host: "box.lan",
        user: "u",
        port: 22,
        key_path: null,
      },
    ],
  });
});
afterEach(cleanup);

async function disconnectSavedRow() {
  await act(async () => {
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
  });
  fireEvent.contextMenu(
    screen.getByText("saved-box").closest('[role="button"]')!,
  );
  const item = useContextMenu
    .getState()
    .items.find((e) => !isSeparator(e) && e.id === "disconnect");
  if (!item || isSeparator(item)) throw new Error("missing Disconnect action");
  await act(async () => {
    item.onSelect?.();
  });
}

it.each(["connected", "connecting"] as const)(
  "NEW-2 review: Disconnect closes all %s sessions for the saved endpoint",
  async (kind) => {
    useConnections.setState({
      active: {
        one: conn("one", canonical, kind),
        two: conn("two", canonical, kind),
      },
    });
    await disconnectSavedRow();
    expect(m.close.mock.calls.map(([id]) => id).sort()).toEqual(["one", "two"]);
  },
);

it("remote-NEW-2 review: saved display alias must not disconnect an unrelated config session", async () => {
  // A config alias was removed/reloaded while its connection remains alive;
  // the now-visible saved host happens to use that alias as its display name.
  useConnections.setState({
    active: {
      one: conn("one", canonical, "connected"),
      unrelated: conn("unrelated", "saved-box", "connected", "different-user"),
    },
  });
  await disconnectSavedRow();
  expect(m.close.mock.calls.map(([id]) => id)).toEqual(["one"]);
});
