/** Sidebar bookmarks/tags: real stores/components, mocked IPC. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import "@/i18n";
import { commands } from "@/types/bindings";
import type { Bookmark, Location } from "@/types/bindings";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import {
  removeBookmark,
  renameBookmark,
  useBookmarks,
} from "@/stores/bookmarks";
import { useConnections } from "@/stores/connections";
import { useToast } from "@/stores/toast";
import { editTagsPrompt, setTags, useTags } from "@/stores/tags";
import { usePromptDialog } from "@/stores/promptDialog";
import { useTagFilter } from "@/stores/tagFilter";
import { TagBar } from "@/components/TagBar";
vi.mock("@/types/bindings", () => ({
  commands: {
    bookmarksAdd: vi.fn(),
    bookmarksRemove: vi.fn(),
    bookmarksRename: vi.fn(),
    hostFavoritesAdd: vi.fn(),
    tagSet: vi.fn(),
  },
}));
const local: Location = { source: { kind: "local" }, path: "/fixture" };
const bm: Bookmark = { id: "bm1", name: "fixture", location: local };
beforeEach(() => {
  vi.resetAllMocks();
  useBookmarks.getState().setAll([]);
  useConnections.setState({ active: {} });
  useTags.getState().setAll({});
  useTagFilter.getState().clear();
  useToast.getState().clear();
});
afterEach(cleanup);

it("add, deduplicate, rename and remove a local bookmark; tags retain stable bookmark ID", async () => {
  vi.mocked(commands.bookmarksAdd).mockResolvedValue({
    status: "ok",
    data: [bm],
  });
  await bookmarkLocation(local, "fixture");
  await bookmarkLocation(local, "fixture");
  expect(commands.bookmarksAdd).toHaveBeenCalledOnce();
  useTags.getState().setAll({ "bm:bm1": ["work"] });
  vi.mocked(commands.bookmarksRename).mockResolvedValue({
    status: "ok",
    data: [{ ...bm, name: "renamed" }],
  });
  await renameBookmark("bm1", "renamed");
  expect(useTags.getState().byKey["bm:bm1"]).toEqual(["work"]);
  vi.mocked(commands.bookmarksRemove).mockResolvedValue({
    status: "ok",
    data: [],
  });
  await removeBookmark("bm1");
  expect(useBookmarks.getState().items).toEqual([]);
});

it("adding remote bookmark without connection reports failure without saving ephemeral ID", async () => {
  await bookmarkLocation(
    {
      source: {
        kind: "ssh",
        connection_id: "fixture:gone",
        host_ip: "192.0.2.1",
        user: "u",
      },
      path: "/srv",
    },
    "srv",
  );
  expect(commands.hostFavoritesAdd).not.toHaveBeenCalled();
  expect(commands.bookmarksAdd).not.toHaveBeenCalled();
  expect(useToast.getState().toasts.at(-1)?.kind).toBe("error");
});

it("tag/untag sidebar key, cancel edit and clear a filter after its final tagged item disappears", async () => {
  vi.mocked(commands.tagSet).mockResolvedValue({
    status: "ok",
    data: { "bm:bm1": ["work"] },
  });
  await setTags("bm:bm1", ["work"]);
  render(<TagBar />);
  fireEvent.click(screen.getByRole("button", { name: "#work" }));
  expect(useTagFilter.getState().active).toEqual(["work"]);
  editTagsPrompt("bm:bm1", ["work"]);
  await act(async () => usePromptDialog.getState().settle(null));
  expect(commands.tagSet).toHaveBeenCalledOnce();
  vi.mocked(commands.tagSet).mockResolvedValue({ status: "ok", data: {} });
  await act(async () => setTags("bm:bm1", []));
  expect(screen.getByRole("button", { name: "#work" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "#work" }));
  expect(useTagFilter.getState().active).toEqual([]);
  expect(screen.queryByRole("button", { name: "#work" })).toBeNull();
});

vi.setConfig({ testTimeout: 30000 });
