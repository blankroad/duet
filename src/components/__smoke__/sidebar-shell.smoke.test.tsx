/**
 * sidebar-shell 사용자 시나리오 스모크 — 상태바·상단바·작업 바·사이드바를 실제 컴포넌트로
 * 렌더하고 클릭/키보드로 끝까지 따라간다. Tauri IPC 는 전부 모킹(실제 fs/원격 접근 없음).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import i18n from "@/i18n";
import { usePanes, type PaneId, type TabState } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useConnections } from "@/stores/connections";
import type { Entry, Location } from "@/types/bindings";
import { StatusBar } from "@/components/StatusBar";

// commands.* 는 무엇을 부르든 빈 성공 — 컴포넌트가 부트스트랩 중 부르는 IPC 를 흡수한다.
vi.mock("@/types/bindings", () => {
  const ok = () => Promise.resolve({ status: "ok", data: [] });
  return {
    commands: new Proxy({}, { get: () => vi.fn(ok) }),
    events: new Proxy(
      {},
      { get: () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }) },
    ),
  };
});

const mk = (
  name: string,
  opts: Partial<Pick<Entry, "kind" | "size" | "hidden">> = {},
): Entry =>
  ({
    name,
    kind: opts.kind ?? "file",
    size: opts.size === undefined ? 100 : opts.size,
    modified_ms: 0,
    permissions: null,
    hidden: opts.hidden ?? false,
  }) as Entry;

const local = (path: string): Location => ({ source: { kind: "local" }, path });

/** 지정 패널의 활성 탭을 덮어쓴다. */
function setTab(id: PaneId, patch: Partial<TabState>) {
  usePanes.setState((s) => {
    const pane = s.panes[id];
    const tabs = pane.tabs.map((t, i) =>
      i === pane.activeTabIndex ? { ...t, ...patch } : t,
    );
    return { panes: { ...s.panes, [id]: { ...pane, tabs } } };
  });
}

function resetPanes() {
  for (const id of ["left", "right"] as const)
    setTab(id, {
      location: local("/fixture"),
      entries: [],
      cursorIndex: -1,
      selected: new Set<string>(),
      showHidden: false,
      filter: "",
      dirSizes: {},
    });
  usePanes.setState({ activePane: "left" });
}

beforeEach(() => {
  resetPanes();
  useUI.setState({ singlePane: false });
  useConnections.setState({ active: {}, hosts: [] });
});
afterEach(cleanup);

describe("상태바", () => {
  it("숨김·필터로 가린 항목은 세지 않고, 숨김 개수를 눌러 바로 숨김 파일을 켠다", () => {
    setTab("left", {
      entries: [
        mk("a.txt"),
        mk("b.txt"),
        mk("logs", { kind: "dir", size: null }),
        mk(".env", { hidden: true }),
        mk(".git", { kind: "dir", size: null, hidden: true }),
      ],
    });
    render(<StatusBar />);
    // 보이는 건 파일 2 + 폴더 1 (숨김 2개는 제외).
    expect(
      screen.getByText(new RegExp(i18n.t("fileKind.files", { count: 2 }))),
    ).toBeTruthy();
    const hiddenBtn = screen.getByRole("button", {
      name: i18n.t("statusbar.hiddenCount", { count: 2 }),
    });
    expect(hiddenBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(hiddenBtn);
    expect(usePanes.getState().panes.left.tabs[0]!.showHidden).toBe(true);
    // 켜진 뒤에는 "표시 중" 으로 바뀌고 다시 누르면 숨긴다.
    const shown = screen.getByRole("button", {
      name: i18n.t("statusbar.hiddenShown", { count: 2 }),
    });
    expect(shown.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByText(new RegExp(i18n.t("fileKind.files", { count: 3 }))),
    ).toBeTruthy();
  });

  it("빠른 필터로 빠진 수를 따로 알린다", () => {
    setTab("left", {
      entries: [mk("alpha.txt"), mk("beta.txt"), mk("gamma.txt")],
      filter: "alp",
    });
    render(<StatusBar />);
    expect(
      screen.getByText(
        new RegExp(i18n.t("statusbar.filteredOut", { count: 2 })),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(i18n.t("fileKind.files", { count: 1 }))),
    ).toBeTruthy();
  });

  it("선택 용량에 계산해 둔 폴더 크기를 더하고, 모르는 폴더가 섞이면 하한(≥)으로 표시한다", () => {
    setTab("left", {
      entries: [
        mk("a.bin", { size: 1024 }),
        mk("docs", { kind: "dir", size: null }),
        mk("raw", { kind: "dir", size: null }),
      ],
      dirSizes: { docs: 1024 },
      selected: new Set(["a.bin", "docs"]),
    });
    render(<StatusBar />);
    expect(screen.getByText(/\(2(\.0)? KB\)|\(2(\.0)? KiB\)/)).toBeTruthy();
    act(() => setTab("left", { selected: new Set(["a.bin", "docs", "raw"]) }));
    expect(screen.getByText(/≥/)).toBeTruthy();
  });

  it("어느 패널 정보인지(L/R)와 원격 연결 상태를 보여 준다", () => {
    setTab("right", {
      location: {
        source: {
          kind: "ssh",
          connection_id: "prod:1",
          host_ip: "10.0.0.1",
          user: "u",
        },
        path: "/srv",
      },
    });
    useConnections.setState({
      active: {
        "prod:1": {
          id: "prod:1",
          alias: "prod",
          host_ip: "10.0.0.1",
          user: "u",
          state: { kind: "connected" },
        },
      },
    });
    render(<StatusBar />);
    expect(screen.getByLabelText(i18n.t("statusbar.paneLeft"))).toBeTruthy();
    act(() => usePanes.setState({ activePane: "right" }));
    expect(screen.getByLabelText(i18n.t("statusbar.paneRight"))).toBeTruthy();
    expect(screen.getByText("prod")).toBeTruthy();
    expect(
      screen.getByLabelText(i18n.t("sidebar.state.connected")),
    ).toBeTruthy();
    // 연결이 끊기면 상태바도 바로 바뀐다.
    act(() =>
      useConnections
        .getState()
        .setState("prod:1", { kind: "error", message: "broken pipe" }),
    );
    expect(screen.getByLabelText("broken pipe")).toBeTruthy();
    // 단일 패널에선 L/R 이 의미 없으니 숨긴다.
    act(() => useUI.setState({ singlePane: true }));
    expect(screen.queryByLabelText(i18n.t("statusbar.paneRight"))).toBeNull();
  });
});
