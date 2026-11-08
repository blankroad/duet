/**
 * sync-compare R2 교차 검토(opus-2) — SC-18 재색인 흐름, SC-20 내용 검색 필터 UI.
 * 모킹은 SearchPanel.test.tsx 와 같다(t = 키 그대로).
 */
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
    indexBuildGlobal: vi.fn().mockResolvedValue({ status: "ok" }),
  },
}));

const local: Location = { source: { kind: "local" }, path: "/fixture/proj" };
const remote: Location = {
  source: {
    kind: "ssh",
    connection_id: "c",
    host_ip: "127.0.0.1",
    user: "u",
  },
  path: "/srv",
};

async function tick(ms = 250) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("SC-18 재색인 흐름", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useIndexStatus.getState().setProgress(500_000, true); // 전역 색인 완료 상태
    useSearch.getState().open("left", local);
    useSearch.getState().setContent(false);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("재색인 버튼은 현재 폴더만 다시 색인(indexReindex)하고 같은 indexSearch 를 다시 부른다 — 전역 색인은 건드리지 않음", async () => {
    useSearch.getState().setQueryNow("new_needle");
    render(<SearchPanel onPickHit={vi.fn()} />);
    await tick();
    expect(commands.indexSearch).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "search.reindex" }));
      await Promise.resolve();
    });
    await tick();
    expect(commands.indexReindex).toHaveBeenCalledWith(local);
    expect(commands.indexBuildGlobal).not.toHaveBeenCalled();
    expect(commands.indexSearch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commands.indexSearch).mock.calls[1]?.[0]).toEqual(local);
    // 백엔드 index_search 는 로컬이면 전역이 있을 때 전역만 본다(commands/search.rs:164-168)
    // → 두 번째 호출도 같은 낡은 전역 결과. 화면엔 "0 hits" 그대로.
  });
});

describe("SC-20 내용 검색 필터 UI", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useIndexStatus.getState().setProgress(1, true);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  for (const [label, root] of [
    ["로컬", local],
    ["원격", remote],
  ] as const) {
    it(`${label} 내용 모드: 크기·날짜·종류 필터가 활성이고 searchGlobal 로 전달된다(백엔드가 무시)`, async () => {
      useSearch.getState().open("left", root);
      useSearch.getState().setContent(true);
      useSearch.getState().setQueryNow("TODO");
      vi.mocked(commands.searchGlobal).mockResolvedValue({
        status: "ok",
        data: [
          {
            location: root,
            name: "tiny.txt",
            kind: "file",
            size: 6,
            modified_ms: 0,
          } as SearchHit,
        ],
      });
      render(<SearchPanel onPickHit={vi.fn()} />);
      const size = screen.getByRole("combobox", {
        name: "search.sizeAny",
      }) as HTMLSelectElement;
      expect(size.disabled).toBe(false);
      expect(screen.queryByText("search.remoteMetadataUnavailable")).toBeNull();
      fireEvent.change(size, { target: { value: "100M" } });
      await tick();
      expect(commands.searchGlobal).toHaveBeenLastCalledWith(
        root,
        "TODO",
        expect.objectContaining({ content: true, min_size: 100 * 1024 ** 2 }),
      );
      // 사용자는 "≥ 100 MB" 를 골랐는데 6 바이트 파일이 결과에 남는다(백엔드 응답 그대로).
      expect(screen.getByText("tiny.txt")).toBeTruthy();
    });
  }
});
