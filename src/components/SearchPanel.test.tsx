import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { Location, SearchHit } from "@/types/bindings";
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

describe("SearchPanel 옛 결과 보호", () => {
  const oldHit: SearchHit = {
    location: local,
    name: "old.txt",
    kind: "file",
    size: 1,
    modified_ms: null,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useSearch.getState().open("left", local);
    useSearch.getState().setContent(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("새 검색이 도는 동안 Enter 는 옛 검색어 결과를 확정하지 않는다", async () => {
    const onPickHit = vi.fn();
    vi.mocked(commands.indexSearch).mockReturnValue(new Promise(() => {}));
    act(() => {
      useSearch.getState().setQueryNow("old");
      useSearch.getState().setResults([oldHit]);
    });
    render(<SearchPanel onPickHit={onPickHit} />);
    const input = screen.getByPlaceholderText("search.namePlaceholder");
    fireEvent.change(input, { target: { value: "newer" } });
    expect(useSearch.getState().status).toBe("searching");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPickHit).not.toHaveBeenCalled();
  });

  it("닫은 뒤 늦게 온 응답이 검색 상태를 다시 채우지 않는다", async () => {
    type SearchResult = Awaited<ReturnType<typeof commands.indexSearch>>;
    let resolve: (v: SearchResult) => void = () => {};
    vi.mocked(commands.indexSearch).mockReturnValue(
      new Promise<SearchResult>((r) => {
        resolve = r;
      }),
    );
    act(() => useSearch.getState().setQueryNow("report"));
    render(<SearchPanel onPickHit={vi.fn()} />);
    await searchNow();
    expect(commands.indexSearch).toHaveBeenCalled();
    act(() => useSearch.getState().close());
    await act(async () => {
      resolve({ status: "ok", data: [oldHit] });
      await Promise.resolve();
    });
    expect(useSearch.getState().results).toEqual([]);
    expect(useSearch.getState().status).toBe("idle");
  });
});
