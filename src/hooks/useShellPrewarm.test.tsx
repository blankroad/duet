import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Entry } from "@/types/bindings";

// Windows 전용 훅 — 테스트 환경에서 platform() 을 "windows" 로 고정.
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
// 예열 호출 여부만 관찰 — 실제 셸/COM 은 건드리지 않는다.
const prewarmShellMenu = vi.fn();
const resetShellPrewarm = vi.fn();
vi.mock("@/lib/shellPrewarm", () => ({
  prewarmShellMenu: (...a: unknown[]) => prewarmShellMenu(...a),
  resetShellPrewarm: (...a: unknown[]) => resetShellPrewarm(...a),
}));

const { usePanes } = await import("@/stores/panes");
const { useContextMenu } = await import("@/stores/contextMenu");
const { useShellPrewarm } = await import("./useShellPrewarm");

const FILE: Entry = {
  name: "report.pdf",
  kind: "file",
  size: 10,
  modified_ms: 0,
  permissions: 0o644,
  hidden: false,
};

/** 활성 로컬 패널의 커서를 주어진 파일에 둔다(store 변경 → 훅 subscribe 트리거). */
function setCursor(name: string) {
  const s = usePanes.getState();
  const entry = { ...FILE, name };
  const tab = {
    ...s.panes.left.tabs[0]!,
    location: { source: { kind: "local" as const }, path: "C:/work" },
    entries: [entry],
    // 비루트 경로는 computeDisplayed 가 index 0 에 ".." 를 넣으므로 파일은 index 1.
    cursorIndex: 1,
  };
  usePanes.setState({
    activePane: "left",
    panes: {
      ...s.panes,
      left: { ...s.panes.left, tabs: [tab], activeTabIndex: 0 },
    },
  });
}

describe("useShellPrewarm 가드", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    prewarmShellMenu.mockReset();
    resetShellPrewarm.mockReset();
    useContextMenu.setState({ open: false });
  });
  afterEach(() => vi.useRealTimers());

  it("커서가 로컬 파일에 멈추면(디바운스) 예열한다 — 기준 동작", () => {
    renderHook(() => useShellPrewarm());
    setCursor("a.pdf");
    vi.advanceTimersByTime(250);
    expect(prewarmShellMenu).toHaveBeenCalledWith("C:/work/a.pdf", "file");
  });

  it("컨텍스트 메뉴가 열려 있으면 settle 이 예열하지 않는다", () => {
    renderHook(() => useShellPrewarm());
    useContextMenu.setState({ open: true });
    setCursor("b.pdf");
    vi.advanceTimersByTime(250);
    expect(prewarmShellMenu).not.toHaveBeenCalled();
  });

  it("메뉴가 열리면 대기 중 예열 예약이 취소된다(우클릭 Build 를 supersede 방지)", () => {
    renderHook(() => useShellPrewarm());
    setCursor("c.pdf"); // 예열 예약(+250ms)
    vi.advanceTimersByTime(100); // 아직 발화 전
    useContextMenu.setState({ open: true }); // 메뉴 오픈 → 타이머 취소
    vi.advanceTimersByTime(250);
    expect(prewarmShellMenu).not.toHaveBeenCalled();
  });
});
