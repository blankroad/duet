/** Phase 1: real SearchPanel/store, mocked IPC. No live application or SSH. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SearchPanel } from "@/components/SearchPanel";
import { commands } from "@/types/bindings";
import type { Location, SearchHit } from "@/types/bindings";
import { useSearch } from "@/stores/search";
import { useIndexStatus } from "@/stores/indexStatus";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/types/bindings", () => ({
  commands: {
    indexEnsure: vi.fn(),
    indexSearch: vi.fn(),
    searchGlobal: vi.fn(),
    searchCancel: vi.fn(),
    indexReindex: vi.fn(),
  },
}));
const local: Location = { source: { kind: "local" }, path: "/fixture" };
const remote: Location = {
  source: {
    kind: "ssh",
    connection_id: "fixture",
    host_ip: "192.0.2.1",
    user: "u",
  },
  path: "/fixture",
};
const hit: SearchHit = {
  location: local,
  name: "old.txt",
  kind: "file",
  size: 1,
  modified_ms: null,
};
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.mocked(commands.indexEnsure).mockResolvedValue({
    status: "ok",
    data: null,
  });
  vi.mocked(commands.indexSearch).mockResolvedValue({
    status: "ok",
    data: [hit],
  });
  vi.mocked(commands.searchGlobal).mockResolvedValue({
    status: "ok",
    data: [hit],
  });
  vi.mocked(commands.indexReindex).mockResolvedValue({
    status: "ok",
    data: null,
  });
  vi.mocked(commands.searchCancel).mockResolvedValue({
    status: "ok",
    data: null,
  });
  useIndexStatus.getState().setProgress(0, true);
  useSearch.getState().open("left", local);
  useSearch.getState().setContent(false);
  useSearch.getState().setQueryNow("old");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("mocked IPC search workflows", () => {
  it.fails(
    "ux-smoke browse-s12 SC-42 ArrowDown Enter must open the next search result",
    async () => {
      const second = { ...hit, name: "second.txt" };
      vi.mocked(commands.indexSearch).mockResolvedValue({
        status: "ok",
        data: [hit, second],
      });
      const pick = vi.fn();
      render(<SearchPanel onPickHit={pick} />);
      await tick();
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown" });
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
      expect(pick).toHaveBeenCalledWith(second);
    },
  );
  it("ux-smoke browse-s01 changing query must prevent clicking stale results", async () => {
    const pick = vi.fn();
    render(<SearchPanel onPickHit={pick} />);
    await tick();
    vi.mocked(commands.indexSearch).mockReturnValue(new Promise(() => {}));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "new" },
    });
    expect(useSearch.getState().status).toBe("searching");
    fireEvent.click(screen.getByRole("button", { name: /old.txt/ }));
    expect(pick).not.toHaveBeenCalled();
  });

  it("browse-s01: results become clickable again once the new search finishes", async () => {
    const pick = vi.fn();
    render(<SearchPanel onPickHit={pick} />);
    await tick();
    const fresh = { ...hit, name: "new.txt" };
    vi.mocked(commands.indexSearch).mockResolvedValue({
      status: "ok",
      data: [fresh],
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "new" },
    });
    await tick();
    expect(useSearch.getState().status).toBe("done");
    fireEvent.click(screen.getByRole("button", { name: /new.txt/ }));
    expect(pick).toHaveBeenCalledWith(fresh);
  });

  it.each([local, remote])(
    "ux-smoke browse-s02 closing active content search cancels backend at $source.kind",
    async (root) => {
      useSearch.setState({ root, content: true });
      vi.mocked(commands.searchGlobal).mockReturnValue(new Promise(() => {}));
      render(<SearchPanel onPickHit={vi.fn()} />);
      await tick();
      expect(commands.searchGlobal).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByRole("button", { name: "search.close" }));
      expect(useSearch.getState().isOpen).toBe(false);
      expect(commands.searchCancel).toHaveBeenCalledOnce();
    },
  );

  it("browse-s02: closing after a content search finished does not cancel", async () => {
    useSearch.setState({ content: true });
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    expect(useSearch.getState().status).toBe("done");
    fireEvent.click(screen.getByRole("button", { name: "search.close" }));
    expect(commands.searchCancel).not.toHaveBeenCalled();
  });

  it("browse-s02: changing the content query does not cancel the new search", async () => {
    useSearch.setState({ content: true });
    vi.mocked(commands.searchGlobal).mockReturnValue(new Promise(() => {}));
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "next" },
    });
    await tick();
    expect(commands.searchGlobal).toHaveBeenCalledTimes(2);
    expect(commands.searchCancel).not.toHaveBeenCalled();
  });

  it.fails(
    "ux-smoke browse-s03 failed reindex must show failure instead of silently rerunning stale cache (SC-42)",
    async () => {
      vi.mocked(commands.indexReindex).mockResolvedValue({
        status: "error",
        error: { kind: "ConnectionFailed", message: "disconnected fixture" },
      });
      render(<SearchPanel onPickHit={vi.fn()} />);
      await tick();
      fireEvent.click(screen.getByRole("button", { name: "search.reindex" }));
      await tick();
      expect(commands.indexReindex).toHaveBeenCalledOnce();
      expect(useSearch.getState().status).toBe("error");
      expect(useSearch.getState().error).toBeTruthy();
    },
  );

  it("close discards late results and reopening can run another search", async () => {
    let finish: (
      r: Awaited<ReturnType<typeof commands.indexSearch>>,
    ) => void = () => {};
    vi.mocked(commands.indexSearch).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await act(async () => {
      finish({ status: "ok", data: [hit] });
    });
    expect(useSearch.getState().results).toEqual([]);
    act(() => {
      useSearch.getState().open("right", remote);
      useSearch.getState().setQueryNow("again");
    });
    await tick();
    expect(commands.indexSearch).toHaveBeenLastCalledWith(
      remote,
      "again",
      expect.any(Object),
    );
    expect(useSearch.getState().status).toBe("done");
  });

  it("completed search Enter opens the full result location and closes", async () => {
    const pick = vi.fn();
    render(<SearchPanel onPickHit={pick} />);
    await tick();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(pick).toHaveBeenCalledWith(hit);
    expect(useSearch.getState().isOpen).toBe(false);
  });
});

vi.setConfig({ testTimeout: 30000 });
