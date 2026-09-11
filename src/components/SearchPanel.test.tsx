import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Location } from "@/types/bindings";
import { commands } from "@/types/bindings";
import { useSearch } from "@/stores/search";
import { SearchPanel } from "./SearchPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/types/bindings", () => ({
  commands: {
    indexEnsure: vi.fn().mockResolvedValue({ status: "ok" }),
    indexSearch: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    searchGlobal: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
  },
}));

const local: Location = { source: { kind: "local" }, path: "/fixture" };
const remote: Location = {
  source: {
    kind: "ssh",
    connection_id: "fixture",
    host_ip: "127.0.0.1",
    user: "test",
  },
  path: "/fixture",
};

async function searchNow() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

describe("SearchPanel metadata filter support", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useSearch.getState().open("left", local);
    useSearch.getState().setContent(false);
    useSearch.getState().setQueryNow("report");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("omits previously selected filters on remote filename search and restores them locally", async () => {
    render(<SearchPanel onPickHit={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "search.kindAny" }), {
      target: { value: "dir" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "search.sizeAny" }), {
      target: { value: "1M" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "search.timeAny" }), {
      target: { value: "7d" },
    });
    await searchNow();
    expect(commands.indexSearch).toHaveBeenLastCalledWith(
      local,
      "report",
      expect.objectContaining({
        only_kind: "dir",
        min_size: 1024 ** 2,
        modified_after_ms: expect.any(Number),
      }),
    );

    act(() => useSearch.setState({ root: remote }));
    await searchNow();
    for (const control of screen.getAllByRole("combobox")) {
      expect((control as HTMLSelectElement).disabled).toBe(true);
      expect((control as HTMLSelectElement).value).toBe("any");
    }
    expect(screen.getByText("search.remoteMetadataUnavailable")).toBeTruthy();
    expect(commands.indexSearch).toHaveBeenLastCalledWith(
      remote,
      "report",
      expect.objectContaining({
        only_kind: null,
        min_size: null,
        modified_after_ms: null,
      }),
    );

    act(() => useSearch.setState({ root: local }));
    await searchNow();
    expect(
      (
        screen.getByRole("combobox", {
          name: "search.kindAny",
        }) as HTMLSelectElement
      ).disabled,
    ).toBe(false);
    expect(commands.indexSearch).toHaveBeenLastCalledWith(
      local,
      "report",
      expect.objectContaining({
        only_kind: "dir",
        min_size: 1024 ** 2,
        modified_after_ms: expect.any(Number),
      }),
    );
  });

  it("retains the existing content-search filters when switching modes", async () => {
    useSearch.setState({ root: remote, content: true });
    render(<SearchPanel onPickHit={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "search.sizeAny" }), {
      target: { value: "10M" },
    });
    await searchNow();
    expect(commands.searchGlobal).toHaveBeenLastCalledWith(
      remote,
      "report",
      expect.objectContaining({ content: true, min_size: 10 * 1024 ** 2 }),
    );

    fireEvent.click(screen.getByRole("button", { name: "search.modeName" }));
    await searchNow();
    expect(commands.indexSearch).toHaveBeenLastCalledWith(
      remote,
      "report",
      expect.objectContaining({ content: false, min_size: null }),
    );
    fireEvent.click(screen.getByRole("button", { name: "search.modeText" }));
    await searchNow();
    expect(commands.searchGlobal).toHaveBeenLastCalledWith(
      remote,
      "report",
      expect.objectContaining({ content: true, min_size: 10 * 1024 ** 2 }),
    );
  });
});
