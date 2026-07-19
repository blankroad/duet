import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { Entry, Location } from "@/types/bindings";
import "@/i18n";

// Tauri command 는 모킹 (CLAUDE.md — 테스트는 실제 fs/원격을 건드리지 않음).
const fsDirSize = vi.fn();
const listDirectory = vi.fn();
vi.mock("@/types/bindings", () => ({
  commands: {
    fsDirSize: (...a: unknown[]) => fsDirSize(...a),
    listDirectory: (...a: unknown[]) => listDirectory(...a),
  },
}));

const { usePanes } = await import("@/stores/panes");
const { PreviewInspector } = await import("./PreviewInspector");

const LOC: Location = { source: { kind: "local" }, path: "/work" };
const DIR: Entry = {
  name: "assets",
  kind: "dir",
  size: null,
  modified_ms: 0,
  permissions: 0o755,
  hidden: false,
};
/** 인스펙터가 받는 location 은 엔트리 자신의 경로. */
const ENTRY_LOC: Location = { source: { kind: "local" }, path: "/work/assets" };

function seedPane(dirSizes: Record<string, number> = {}) {
  const s = usePanes.getState();
  const tab = {
    ...s.panes.left.tabs[0]!,
    location: LOC,
    entries: [DIR],
    dirSizes,
  };
  usePanes.setState({
    activePane: "left",
    panes: {
      ...s.panes,
      left: { ...s.panes.left, tabs: [tab], activeTabIndex: 0 },
    },
  });
}

/** dt 라벨에 대응하는 dd 텍스트. */
function rowValue(label: string): string {
  const dt = screen.getByText(label);
  return dt.nextElementSibling?.textContent ?? "";
}

describe("PreviewInspector 폴더 크기", () => {
  beforeEach(() => {
    fsDirSize.mockReset();
    listDirectory.mockReset();
    listDirectory.mockResolvedValue({ status: "ok", data: [DIR, DIR, DIR] });
  });

  it("캐시에 값이 있으면 즉시 전체 용량을 보여준다", () => {
    seedPane({ assets: 1_500_000_000 });
    render(<PreviewInspector entry={DIR} location={ENTRY_LOC} paneId="left" />);

    expect(rowValue("Size")).toBe("1.4 GB");
    expect(fsDirSize).not.toHaveBeenCalled(); // 자동 계산 금지
  });

  it("캐시가 없으면 계산하지 않고 버튼만 노출한다", () => {
    seedPane();
    render(<PreviewInspector entry={DIR} location={ENTRY_LOC} paneId="left" />);

    expect(screen.getByRole("button", { name: "Calculate" })).toBeDefined();
    expect(fsDirSize).not.toHaveBeenCalled();
  });

  it("버튼을 누르면 재귀 크기를 계산해 표시한다", async () => {
    seedPane();
    fsDirSize.mockResolvedValue({ status: "ok", data: 4096 });
    render(<PreviewInspector entry={DIR} location={ENTRY_LOC} paneId="left" />);

    fireEvent.click(screen.getByRole("button", { name: "Calculate" }));

    await waitFor(() => expect(rowValue("Size")).toBe("4.0 KB"));
    expect(fsDirSize).toHaveBeenCalledWith({
      source: { kind: "local" },
      path: "/work/assets",
    });
    // 탭 캐시에도 남아 크기 컬럼과 공유된다.
    expect(usePanes.getState().panes.left.tabs[0]!.dirSizes.assets).toBe(4096);
  });

  it("폴더는 항목 수 행을 유지한 채 크기 행이 따로 붙는다", async () => {
    seedPane({ assets: 4096 });
    render(<PreviewInspector entry={DIR} location={ENTRY_LOC} paneId="left" />);

    await waitFor(() => expect(rowValue("Items")).toBe("3 items"));
    expect(rowValue("Size")).toBe("4.0 KB");
  });

  it("파일은 Entry.size 를 그대로 쓰고 계산 버튼이 없다", () => {
    seedPane();
    const file: Entry = { ...DIR, name: "a.bin", kind: "file", size: 2048 };
    render(
      <PreviewInspector
        entry={file}
        location={{ source: { kind: "local" }, path: "/work/a.bin" }}
        paneId="left"
      />,
    );

    expect(rowValue("Size")).toBe("2.0 KB");
    expect(screen.queryByRole("button", { name: "Calculate" })).toBeNull();
    expect(screen.queryByText("Items")).toBeNull();
  });
});
