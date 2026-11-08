/**
 * sync-compare 점검(opus-1, C-24) — SearchPanel 사용자 흐름.
 * 모킹은 SearchPanel.test.tsx 와 같다(t = 키 그대로).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { Location, SearchHit } from "@/types/bindings";
import { commands } from "@/types/bindings";
import { useSearch } from "@/stores/search";
import { useIndexStatus } from "@/stores/indexStatus";
import { SearchPanel } from "../SearchPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/types/bindings", () => ({
  commands: {
    indexEnsure: vi.fn().mockResolvedValue({ status: "ok" }),
    indexSearch: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    searchGlobal: vi.fn().mockResolvedValue({ status: "ok", data: [] }),
    indexReindex: vi.fn().mockResolvedValue({ status: "ok" }),
  },
}));

const local: Location = { source: { kind: "local" }, path: "/fixture" };
const hit: SearchHit = {
  location: local,
  name: "report.txt",
  kind: "file",
  size: 10,
  modified_ms: 0,
} as SearchHit;

async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("C-24 SearchPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useIndexStatus.getState().setProgress(0, true);
    useSearch.getState().open("left", local);
    useSearch.getState().setContent(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("늦게 온 옛 검색 응답은 새 결과를 덮지 않는다(경쟁 가드 동작)", async () => {
    let slow: (
      v: Awaited<ReturnType<typeof commands.indexSearch>>,
    ) => void = () => {};
    vi.mocked(commands.indexSearch)
      .mockReturnValueOnce(
        new Promise((r) => {
          slow = r;
        }) as ReturnType<typeof commands.indexSearch>,
      )
      .mockResolvedValueOnce({
        status: "ok",
        data: [{ ...hit, name: "new.txt" }],
      });
    useSearch.getState().setQueryNow("old");
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    act(() => useSearch.getState().setQueryNow("new"));
    await tick();
    await act(async () => {
      slow({ status: "ok", data: [{ ...hit, name: "old.txt" }] });
      await Promise.resolve();
    });
    expect(screen.getByText("new.txt")).toBeTruthy();
    expect(screen.queryByText("old.txt")).toBeNull();
  });

  it("검색 실패 문구는 검색어를 지운 뒤(2글자 미만) 사라진다(OK — setResults 가 error 를 지움)", async () => {
    vi.mocked(commands.indexSearch).mockResolvedValueOnce({
      status: "error",
      error: { kind: "PermissionDenied", message: "permission denied" },
    });
    useSearch.getState().setQueryNow("report");
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    expect(useSearch.getState().status).toBe("error");
    act(() => useSearch.getState().setQueryNow("r"));
    await tick();
    expect(useSearch.getState().error).toBeNull();
  });

  it.fails(
    "sync-compare: 전체 드라이브 색인이 끝나기 전에도 현재 검색의 결과 개수를 보여야 한다",
    async () => {
      useIndexStatus.getState().setProgress(12345, false);
      vi.mocked(commands.indexSearch).mockResolvedValueOnce({
        status: "ok",
        data: [hit],
      });
      useSearch.getState().setQueryNow("report");
      render(<SearchPanel onPickHit={vi.fn()} />);
      await tick();
      expect(screen.getByText("report.txt")).toBeTruthy();
      // 현재는 상태 칸이 계속 "search.indexingDrive" — 결과가 떠도 개수 대신 색인 진행만.
      expect(screen.getByText("search.hits")).toBeTruthy();
    },
  );

  it("재색인 버튼: 누른 뒤 끝날 때까지 아무 표시가 없다(현재 동작 기록)", async () => {
    let done: (
      v: Awaited<ReturnType<typeof commands.indexReindex>>,
    ) => void = () => {};
    vi.mocked(commands.indexReindex).mockReturnValueOnce(
      new Promise((r) => {
        done = r;
      }) as ReturnType<typeof commands.indexReindex>,
    );
    useSearch.getState().setQueryNow("report");
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    act(() => screen.getByRole("button", { name: "search.reindex" }).click());
    await tick(50);
    expect(screen.queryByText("search.indexing")).toBeNull();
    await act(async () => {
      done({ status: "error", error: { kind: "Io", message: "x" } });
      await Promise.resolve();
    });
    // 재색인 실패도 화면에 남지 않는다.
    expect(useSearch.getState().error).toBeNull();
  });
});
