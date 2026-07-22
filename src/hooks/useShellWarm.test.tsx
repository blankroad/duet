import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Entry } from "@/types/bindings";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
const warmShellMenu = vi.fn();
vi.mock("@/lib/shellMenu", () => ({
  warmShellMenu: (...a: unknown[]) => warmShellMenu(...a),
}));

const { usePanes } = await import("@/stores/panes");
const { useContextMenu } = await import("@/stores/contextMenu");
const { useShellWarm } = await import("./useShellWarm");

const FILE: Entry = {
  name: "report.pdf",
  kind: "file",
  size: 10,
  modified_ms: 0,
  permissions: 0o644,
  hidden: false,
};

/** 활성 로컬 패널 커서를 주어진 파일에 둔다. 비루트라 표시상 index 0 은 "..", 파일은 1. */
function setCursor(name: string) {
  const s = usePanes.getState();
  const tab = {
    ...s.panes.left.tabs[0]!,
    location: { source: { kind: "local" as const }, path: "C:/work" },
    entries: [{ ...FILE, name }],
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

describe("useShellWarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    warmShellMenu.mockReset();
    useContextMenu.setState({ open: false });
  });
  afterEach(() => vi.useRealTimers());

  it("커서가 로컬 파일에 멈추면(디바운스) 예열한다", () => {
    renderHook(() => useShellWarm());
    setCursor("a.pdf");
    vi.advanceTimersByTime(250);
    expect(warmShellMenu).toHaveBeenCalledWith("C:/work/a.pdf", "file");
  });

  it("메뉴가 열려 있으면 settle 이 예열하지 않는다(STA 점유 최소화)", () => {
    renderHook(() => useShellWarm());
    useContextMenu.setState({ open: true });
    setCursor("b.pdf");
    vi.advanceTimersByTime(250);
    expect(warmShellMenu).not.toHaveBeenCalled();
  });

  it("메뉴가 열리면 대기 중 예열 예약이 취소된다", () => {
    renderHook(() => useShellWarm());
    setCursor("c.pdf");
    vi.advanceTimersByTime(100);
    useContextMenu.setState({ open: true });
    vi.advanceTimersByTime(250);
    expect(warmShellMenu).not.toHaveBeenCalled();
  });
});
