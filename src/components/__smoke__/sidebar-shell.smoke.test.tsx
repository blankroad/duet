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
import { TopBar } from "@/components/TopBar";
import { useCommands } from "@/stores/commands";
import { useKeymap } from "@/stores/keymap";
import { displayKey } from "@/lib/keyDisplay";
import type { Command } from "@/lib/commands";
import { Sidebar } from "@/components/Sidebar";
import { useBookmarks } from "@/stores/bookmarks";
import { useHostFavorites } from "@/stores/hostFavorites";
import { useSavedHosts } from "@/stores/savedHosts";
import { useRecents } from "@/stores/recents";
import { useTags } from "@/stores/tags";
import { useTagFilter } from "@/stores/tagFilter";
import { useSidebarFilter } from "@/stores/sidebarFilter";
import { useHostGroups } from "@/stores/sidebarGroups";

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

// 창 API — onResized 등록을 테스트가 직접 끝낼 수 있게 deferred 로 둔다.
const win = vi.hoisted(() => ({
  unlisten: vi.fn(),
  resolveResized: null as null | ((u: () => void) => void),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () =>
      new Promise<() => void>((resolve) => {
        win.resolveResized = resolve;
      }),
    minimize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    close: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

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

const cmd = (id: string, defaultKey: string): Command => ({
  id,
  label: id,
  category: "View",
  defaultKey,
  action: () => {},
});

describe("상단바", () => {
  beforeEach(() => {
    useCommands.setState({
      builtins: [
        cmd("view.toggleSidebar", "Ctrl+B"),
        cmd("view.togglePreview", "F11"),
        cmd("view.singlePane", "Ctrl+Shift+D"),
      ],
    });
    useKeymap.setState({ bindings: [] });
    useUI.setState({
      sidebarOpen: true,
      previewOpen: false,
      singlePane: false,
    });
  });

  it("미리보기 토글 툴팁이 현재 키맵을 따른다 (F11 고정 아님)", () => {
    render(<TopBar />);
    const label = i18n.t("topbar.togglePreview", { key: displayKey("F11") });
    expect(screen.getByRole("button", { name: label })).toBeTruthy();
    act(() =>
      useKeymap.setState({
        bindings: [{ key: "Ctrl+Alt+P", command_id: "view.togglePreview" }],
      }),
    );
    expect(
      screen.getByRole("button", {
        name: i18n.t("topbar.togglePreview", { key: displayKey("Ctrl+Alt+P") }),
      }),
    ).toBeTruthy();
  });

  it("토글 버튼은 켜짐/꺼짐을 aria-pressed 로 알리고 클릭으로 바뀐다", () => {
    render(<TopBar />);
    const preview = screen.getByRole("button", {
      name: i18n.t("topbar.togglePreview", { key: displayKey("F11") }),
    });
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(preview);
    expect(useUI.getState().previewOpen).toBe(true);
    expect(preview.getAttribute("aria-pressed")).toBe("true");
    // 일반 액션 버튼(설정 등)은 토글 속성을 갖지 않는다.
    const settings = screen.getByRole("button", {
      name: i18n.t("topbar.settings", { key: "" }),
    });
    expect(settings.hasAttribute("aria-pressed")).toBe(false);
  });

  it("창 리스너 등록 전에 unmount 돼도 등록이 끝나면 바로 해제한다", async () => {
    const { unmount } = render(<TopBar />);
    unmount();
    await act(async () => {
      win.resolveResized?.(win.unlisten);
      await Promise.resolve();
    });
    expect(win.unlisten).toHaveBeenCalled();
  });
});

// ─────────────────────────── 사이드바 ───────────────────────────

const sidebarProps = {
  onHostActivate: vi.fn(),
  onAdHocOpen: vi.fn(),
  onSavedActivate: vi.fn(),
  onOpenLocation: vi.fn(),
  onOpenHostPath: vi.fn(),
  onAddBookmark: vi.fn(),
  onTrashActivate: vi.fn(),
  onEject: vi.fn(),
};

const sshSrc = (id: string) =>
  ({ kind: "ssh", connection_id: id, host_ip: "10.0.0.1", user: "u" }) as const;

function conn(id: string, alias: string, kind: "connected" | "connecting") {
  return { id, alias, host_ip: "10.0.0.1", user: "u", state: { kind } };
}

function resetSidebarStores() {
  useUI.setState({ sidebarOpen: true, collapsed: {} });
  useConnections.setState({
    active: {},
    hosts: [
      {
        alias: "prod",
        hostname: "10.0.0.1",
        port: 22,
        user: "u",
        has_proxy_jump: false,
      },
    ],
  });
  useSavedHosts.setState({ hosts: [] });
  useBookmarks.setState({ items: [] });
  useHostFavorites.setState({ items: [] });
  useRecents.setState({ items: [] });
  useTags.setState({ byKey: {} });
  useTagFilter.setState({ active: [] });
  useSidebarFilter.setState({ q: "", focusNonce: 0 });
  useHostGroups.setState({ groups: [] });
}

/**
 * 텍스트가 맞는 사이드바 행 — 같은 글자가 여러 곳(호스트 행·즐겨찾기 그룹 머리글)에
 * 있으면 열 수 있는 행(role=button)을 우선한다.
 */
function row(name: string): HTMLElement {
  const els = screen.getAllByText(name);
  for (const el of els) {
    const r = el.closest('[role="button"]');
    if (r) return r as HTMLElement;
  }
  const b = els[0]?.closest("button");
  if (!b) throw new Error(`row not found: ${name}`);
  return b;
}

/** 사이드바 렌더 — 마운트 시 볼륨 재스캔(비동기 IPC)까지 끝낸다. */
async function renderSidebar() {
  let r: ReturnType<typeof render> | undefined;
  await act(async () => {
    r = render(<Sidebar {...sidebarProps} />);
  });
  return r!;
}

describe("사이드바 — 상태 표시", () => {
  beforeEach(resetSidebarStores);

  it("호스트 연결 상태 점이 연결/끊김에 바로 반응한다", async () => {
    await renderSidebar();
    const label = (k: string) => i18n.t(`sidebar.state.${k}`);
    expect(
      row("prod").querySelector(`[aria-label="${label("disconnected")}"]`),
    ).toBeTruthy();
    act(() =>
      useConnections
        .getState()
        .upsertActive(conn("prod:1", "prod", "connecting")),
    );
    expect(
      row("prod").querySelector(`[aria-label="${label("connecting")}"]`),
    ).toBeTruthy();
    act(() =>
      useConnections.getState().setState("prod:1", { kind: "connected" }),
    );
    expect(
      row("prod").querySelector(`[aria-label="${label("connected")}"]`),
    ).toBeTruthy();
    act(() => useConnections.getState().removeActive("prod:1"));
    expect(
      row("prod").querySelector(`[aria-label="${label("disconnected")}"]`),
    ).toBeTruthy();
  });

  it("패널이 보고 있는 호스트·원격 즐겨찾기에 L/R 배지가 붙는다", async () => {
    useConnections.setState({
      active: { "prod:1": conn("prod:1", "prod", "connected") },
    });
    useHostFavorites.setState({
      items: [{ id: "f1", host_alias: "prod", name: "logs", path: "/var/log" }],
    });
    setTab("right", {
      location: { source: sshSrc("prod:1"), path: "/var/log" },
    });
    await renderSidebar();
    expect(row("prod").textContent).toContain("R");
    expect(row("logs").textContent).toContain("R");
    // 원격 즐겨찾기 그룹 머리글도 모양 표식(연결됨)으로 보인다.
    const groupHeader = screen
      .getAllByText("prod")
      .find((el) => el.closest("button[aria-expanded]"));
    expect(
      groupHeader
        ?.closest("button")
        ?.querySelector(`[aria-label="${i18n.t("sidebar.state.connected")}"]`),
    ).toBeTruthy();
  });

  it("저장 호스트도 연결 상태를 보여 준다", async () => {
    useSavedHosts.setState({
      hosts: [
        { alias: "lab", host: "10.0.0.9", port: 22, user: "u", key_path: null },
      ],
    });
    useConnections.setState({
      active: { "lab:1": conn("lab:1", "lab", "connected") },
    });
    await renderSidebar();
    expect(
      row("lab").querySelector(
        `[aria-label="${i18n.t("sidebar.state.connected")}"]`,
      ),
    ).toBeTruthy();
  });
});
