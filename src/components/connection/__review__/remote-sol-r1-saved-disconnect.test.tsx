/** Saved/ad-hoc sessions lack the disconnect menu offered for config hosts. */
import { afterEach, expect, it, vi } from "vitest";
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
import { usePanes } from "@/stores/panes";
import { useContextMenu, isSeparator } from "@/stores/contextMenu";
import { useHostGroups } from "@/stores/sidebarGroups";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useBookmarks } from "@/stores/bookmarks";
import { useRecents } from "@/stores/recents";
import { useSidebarFilter } from "@/stores/sidebarFilter";
import { useTagFilter } from "@/stores/tagFilter";

vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {},
    {
      get: () => vi.fn(async () => ({ status: "ok", data: [] })),
    },
  ),
}));
afterEach(cleanup);

it.fails(
  "remote-NEW-2 repro: connected saved host exposes a Disconnect action",
  async () => {
    useUI.setState({ sidebarOpen: true, collapsed: {} });
    useSidebarFilter.setState({ q: "" });
    useTagFilter.setState({ active: [] });
    useHostGroups.setState({ groups: [] });
    useHostFavorites.setState({ items: [] });
    useBookmarks.setState({ items: [] });
    useRecents.setState({ items: [] });
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/test" }, []);
    useSavedHosts.setState({
      hosts: [
        {
          alias: "saved-box",
          host: "box.lan",
          port: 22,
          user: "u",
          key_path: null,
        },
      ],
    });
    useConnections.setState({
      hosts: [],
      reconnecting: {},
      active: {
        "u@box.lan:22:one": {
          id: "u@box.lan:22:one",
          alias: "u@box.lan:22",
          host_ip: "10.0.0.2",
          user: "u",
          state: { kind: "connected" },
        },
      },
    });
    await act(async () => {
      render(
        <Sidebar
          onHostActivate={vi.fn()}
          onAdHocOpen={vi.fn()}
          onSavedActivate={vi.fn()}
          onOpenLocation={vi.fn()}
          onOpenHostPath={vi.fn()}
          onAddBookmark={vi.fn()}
          onTrashActivate={vi.fn()}
          onEject={vi.fn()}
        />,
      );
    });
    const row = screen.getByText("saved-box").closest('[role="button"]');
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row!);
    const ids = useContextMenu
      .getState()
      .items.map((e) => (isSeparator(e) ? null : e.id))
      .filter((id) => id !== null);
    expect(ids).toContain("connect");
    expect(ids).toContain("disconnect");
  },
);
