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
import { usePlaces } from "@/stores/places";
import { TasksBar } from "@/components/TasksBar";
import { useTasks } from "@/stores/tasks";
import { useUIDialogs } from "@/stores/ui-dialogs";
import type { TaskDto } from "@/types/bindings";
import { usePromptDialog } from "@/stores/promptDialog";
import { useContextMenu, type MenuItem } from "@/stores/contextMenu";
import { useHostNicknames } from "@/stores/hostNicknames";
import { beginWidthDrag } from "@/stores/panelWidth";
import { reorderSavedHosts } from "@/stores/savedHosts";
import { useAppLaunchers } from "@/stores/appLaunchers";
import type { AppItem } from "@/types/bindings";

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

describe("사이드바 — 키보드·접근성", () => {
  beforeEach(resetSidebarStores);

  it("섹션 머리글은 펼침 상태를 aria-expanded 로 알리고 클릭으로 접힌다", async () => {
    await renderSidebar();
    const header = screen.getByRole("button", {
      name: i18n.t("sidebar.hosts"),
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("prod")).toBeNull();
  });

  it("볼륨 행도 Tab 으로 닿고 Enter 로 열린다, 행 안 꺼내기 버튼의 Enter 는 행을 열지 않는다", async () => {
    await renderSidebar();
    act(() =>
      usePlaces
        .getState()
        .setVolumes("local", [
          { name: "USB", path: "/Volumes/USB", ejectable: true },
        ]),
    );
    const volume = row("USB");
    expect(volume.tabIndex).toBe(0);
    fireEvent.keyDown(volume, { key: "Enter" });
    expect(sidebarProps.onOpenLocation).toHaveBeenCalledWith(
      { source: { kind: "local" }, path: "/Volumes/USB" },
      "left",
    );
    sidebarProps.onOpenLocation.mockClear();
    const eject = screen.getByRole("button", {
      name: i18n.t("sidebar.ejectName", { name: "USB" }),
    });
    fireEvent.keyDown(eject, { key: "Enter" });
    expect(sidebarProps.onOpenLocation).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── 작업 바 ───────────────────────────

function task(
  id: string,
  status: "queued" | "running",
  percent: number | null = 40,
): TaskDto {
  return {
    id,
    kind: "copy",
    status: { kind: status },
    title: `Copying ${id}.zip → /tmp`,
    host_key: { kind: "local" },
    progress:
      status === "running"
        ? {
            bytes_done: 400,
            bytes_total: percent == null ? null : 1000,
            speed_bps: null,
            eta_sec: null,
            percent,
            current_file: `${id}.zip`,
            files_done: 0,
            files_total: 1,
          }
        : null,
    error_message: null,
    affected_locations: [],
  } as unknown as TaskDto;
}

function setTasks(ts: TaskDto[]) {
  act(() => useTasks.getState().setAll(ts));
}

describe("작업 바", () => {
  beforeEach(() => {
    useTasks.setState({ tasks: new Map(), cancelling: new Set() });
    useUIDialogs.setState({ dialog: { kind: "none" } });
  });

  it("작업이 2개가 돼도 보고 있던 작업의 진행 막대와 취소가 그대로 남는다", () => {
    render(<TasksBar />);
    setTasks([task("big", "running")]);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "40",
    );
    expect(
      screen.getAllByRole("button", { name: i18n.t("sidebar.cancelTask") }),
    ).toHaveLength(1);
    setTasks([task("big", "running"), task("small", "queued")]);
    // 접힌 상태에서도 대표 작업 행(막대·취소)이 보인다.
    expect(screen.getByText("big.zip")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: i18n.t("sidebar.cancelTask") }),
    ).toHaveLength(1);
    // 펼치면 대기 작업이 "대기 중" 으로 구분돼 보인다.
    const toggle = screen.getByRole("button", { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(new RegExp(i18n.t("tasks.queued")))).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: i18n.t("sidebar.cancelTask") }),
    ).toHaveLength(2);
  });

  it("대기 작업이 먼저 들어와 있어도 요약 줄은 실행 중인 작업을 보여 준다", () => {
    render(<TasksBar />);
    setTasks([task("waiting", "queued"), task("busy", "running")]);
    expect(screen.getByText("busy.zip")).toBeTruthy();
  });

  it("총량을 모르는 작업은 0% 대신 진행 중 애니메이션으로 보인다", () => {
    render(<TasksBar />);
    setTasks([task("dir", "running", null)]);
    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(bar.querySelector(".animate-indeterminate")).toBeTruthy();
  });

  it("작업 이름을 누르면 진행 상세 창을 다시 연다", () => {
    render(<TasksBar />);
    setTasks([task("big", "running")]);
    fireEvent.click(screen.getByText("big.zip"));
    expect(useUIDialogs.getState().dialog).toMatchObject({
      kind: "progress",
      taskId: "big",
    });
  });
});

describe("사이드바 — 키가 패널로 새지 않는다", () => {
  const winKeys = vi.fn();
  beforeEach(() => {
    resetSidebarStores();
    useCommands.setState({
      builtins: [
        { ...cmd("file.delete", "Delete"), category: "File" },
        { ...cmd("file.rename", "F2"), category: "File" },
        cmd("view.togglePreview", "F11"),
      ],
      dynamic: [],
    });
    useKeymap.setState({ bindings: [] });
    usePromptDialog.setState({ req: null });
    useBookmarks.setState({
      items: [{ id: "b1", name: "work", location: local("/work") }],
    });
    useRecents.setState({
      items: [{ source: "local", path: "/projects", label: "projects" }],
    });
    window.addEventListener("keydown", winKeys);
    winKeys.mockClear();
  });
  afterEach(() => window.removeEventListener("keydown", winKeys));

  it("북마크 행에서 Delete 는 북마크만 지우고 패널(휴지통 삭제)로 가지 않는다", async () => {
    await renderSidebar();
    const bm = row("work");
    bm.focus();
    await act(async () => {
      fireEvent.keyDown(bm, { key: "Delete", code: "Delete" });
    });
    expect(winKeys).not.toHaveBeenCalled();
    expect(useBookmarks.getState().items).toHaveLength(0);
  });

  it("이름 바꾸기 키는 키맵을 따른다 — F2 를 다른 커맨드에 매면 행 이름 바꾸기도 안 뜬다", async () => {
    await renderSidebar();
    const bm = row("work");
    fireEvent.keyDown(bm, { key: "F2", code: "F2" });
    expect(usePromptDialog.getState().req).not.toBeNull();
    act(() => usePromptDialog.getState().settle(null));
    useKeymap.setState({
      bindings: [
        { key: "F2", command_id: "view.togglePreview" },
        { key: "Shift+R", command_id: "file.rename" },
      ],
    });
    fireEvent.keyDown(bm, { key: "F2", code: "F2" });
    expect(usePromptDialog.getState().req).toBeNull();
    // 파일 외 커맨드(미리보기 토글)는 사이드바에서도 그대로 전역으로 통과한다.
    expect(winKeys).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(bm, { key: "R", code: "KeyR", shiftKey: true });
    expect(usePromptDialog.getState().req).not.toBeNull();
  });

  it("필터에서 ↓ 로 결과 행에 들어가 ↑↓ 로 움직이고 Esc 로 나온다", async () => {
    await renderSidebar();
    const filter = screen.getByLabelText(i18n.t("sidebar.filterLabel"));
    fireEvent.change(filter, { target: { value: "o" } });
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    const first = document.activeElement as HTMLElement;
    expect(first.hasAttribute("data-sidebar-row")).toBe(true);
    // 입력칸 키는 전역 처리기가 원래 무시한다 — 여기서부터 행 위의 키만 본다.
    winKeys.mockClear();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = document.activeElement as HTMLElement;
    expect(second).not.toBe(first);
    expect(second.hasAttribute("data-sidebar-row")).toBe(true);
    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    expect(winKeys).not.toHaveBeenCalled();
    fireEvent.keyDown(first, { key: "Escape" });
    expect(document.activeElement).toBe(document.body);
  });

  it("필터에서 Enter 는 첫 결과를 연다", async () => {
    await renderSidebar();
    const filter = screen.getByLabelText(i18n.t("sidebar.filterLabel"));
    fireEvent.change(filter, { target: { value: "work" } });
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(sidebarProps.onOpenLocation).toHaveBeenCalledWith(
      local("/work"),
      "left",
    );
  });

  it("마우스로 행을 열면 포커스를 내려놓아 이어지는 키가 패널로 간다", async () => {
    await renderSidebar();
    const bm = row("work");
    bm.focus();
    fireEvent.click(bm, { detail: 1 });
    expect(document.activeElement).not.toBe(bm);
    const recent = row("projects");
    recent.focus();
    fireEvent.click(recent, { detail: 1 });
    expect(document.activeElement).not.toBe(recent);
    // 섹션 머리글 같은 버튼도(Windows 는 클릭한 버튼이 포커스를 가진다) 내려놓는다.
    const header = screen.getByRole("button", {
      name: i18n.t("sidebar.hosts"),
    });
    header.focus();
    fireEvent.click(header, { detail: 1 });
    expect(document.activeElement).not.toBe(header);
    // 필터 입력칸은 타이핑하러 누른 것이라 포커스를 유지한다.
    const filter = screen.getByLabelText(i18n.t("sidebar.filterLabel"));
    filter.focus();
    fireEvent.click(filter, { detail: 1 });
    expect(document.activeElement).toBe(filter);
  });
});

describe("사이드바 — 필터·태그", () => {
  beforeEach(resetSidebarStores);

  it("켜 둔 태그가 마지막 항목에서 지워져도 칩과 지우기가 남아 필터를 풀 수 있다", async () => {
    useTags.setState({ byKey: { "host:prod": ["web"] } });
    await renderSidebar();
    const chip = screen.getByRole("button", { name: "#web" });
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    // 태그 편집으로 마지막 #web 이 사라진다 → 필터는 남아 호스트를 가린다.
    act(() => useTags.setState({ byKey: {} }));
    expect(screen.queryByText("prod")).toBeNull();
    expect(screen.getByRole("button", { name: "#web" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("tags.clear") }));
    expect(screen.getByText("prod")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "#web" })).toBeNull();
  });

  it("필터 커맨드는 닫힌 사이드바를 열어 포커스하고, 다시 열 때는 포커스를 빼앗지 않는다", async () => {
    useUI.setState({ sidebarOpen: false });
    await renderSidebar();
    act(() => useSidebarFilter.getState().requestFocus());
    expect(useUI.getState().sidebarOpen).toBe(true);
    const filter = screen.getByLabelText(i18n.t("sidebar.filterLabel"));
    expect(document.activeElement).toBe(filter);
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => useUI.getState().toggleSidebar());
    act(() => useUI.getState().toggleSidebar());
    expect(document.activeElement).toBe(document.body);
  });

  it("이름 필터는 접힌 즐겨찾기 그룹도 펼치고, 걸린 게 없는 섹션은 숨긴다", async () => {
    useUI.setState({ collapsed: { "fav:prod": true } });
    useHostFavorites.setState({
      items: [{ id: "f1", host_alias: "prod", name: "logs", path: "/var/log" }],
    });
    await renderSidebar();
    expect(screen.queryByText("logs")).toBeNull();
    act(() => useSidebarFilter.getState().set("logs"));
    expect(screen.getByText("logs")).toBeTruthy();
    // Hosts 섹션은 걸린 호스트가 없으니 머리글째 사라진다.
    expect(
      screen.queryByRole("button", { name: i18n.t("sidebar.hosts") }),
    ).toBeNull();
  });

  it("필터 중에는 걸린 멤버가 없는 호스트 그룹 머리글을 숨긴다", async () => {
    useSavedHosts.setState({
      hosts: [
        { alias: "alpha", host: "a", port: 22, user: "u", key_path: null },
        { alias: "beta", host: "b", port: 22, user: "u", key_path: null },
      ],
    });
    useHostGroups.setState({
      groups: [{ id: "g1", name: "BetaGroup", members: ["beta"] }],
    });
    await renderSidebar();
    expect(screen.getByText("BetaGroup")).toBeTruthy();
    act(() => useSidebarFilter.getState().set("alpha"));
    expect(screen.queryByText("BetaGroup")).toBeNull();
    expect(screen.getByText("alpha")).toBeTruthy();
  });

  it("필터바는 스크롤 영역 밖에 있어 섹션 제목(sticky)을 가리지 않는다", async () => {
    await renderSidebar();
    const filter = screen.getByLabelText(i18n.t("sidebar.filterLabel"));
    const header = screen.getByRole("button", {
      name: i18n.t("sidebar.hosts"),
    });
    const scroller = header.closest(".overflow-y-auto");
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(filter)).toBe(false);
  });
});

describe("사이드바 — 최근·즐겨찾기", () => {
  beforeEach(resetSidebarStores);

  it("최근 항목 하나만 우클릭으로 빼고, 원격 항목은 별명으로, 보고 있는 로컬 폴더엔 L/R", async () => {
    useHostNicknames.setState({ byAlias: { prod: "운영서버" } });
    useRecents.setState({
      items: [
        { source: "local", path: "/fixture", label: "fixture" },
        { source: "ssh", alias: "prod", path: "/srv", label: "srv" },
      ],
    });
    await renderSidebar();
    expect(row("fixture").textContent).toContain("L");
    expect(row("srv").textContent).toContain("운영서버");
    fireEvent.contextMenu(row("fixture"));
    const remove = useContextMenu
      .getState()
      .items.find((i) => (i as MenuItem).id === "remove") as MenuItem;
    act(() => remove.onSelect?.());
    expect(screen.queryByText("fixture")).toBeNull();
    expect(screen.getByText("srv")).toBeTruthy();
  });

  it("연결된 원격 즐겨찾기 행은 파일 드롭 대상(그 폴더로 복사)이다", async () => {
    useHostFavorites.setState({
      items: [{ id: "f1", host_alias: "prod", name: "logs", path: "/var/log" }],
    });
    await renderSidebar();
    expect(row("logs").hasAttribute("data-drop-path")).toBe(false);
    act(() =>
      useConnections.setState({
        active: { "prod:1": conn("prod:1", "prod", "connected") },
      }),
    );
    expect(row("logs").getAttribute("data-drop-path")).toBe("/var/log");
    expect(
      JSON.parse(row("logs").getAttribute("data-drop-source")!),
    ).toMatchObject({
      kind: "ssh",
      connection_id: "prod:1",
    });
  });
});

describe("폭 드래그·재정렬 생명주기", () => {
  beforeEach(resetSidebarStores);

  it("폭 드래그가 취소(pointercancel)되면 이후 포인터 이동이 폭을 바꾸지 않는다", () => {
    const setWidth = vi.fn();
    beginWidthDrag(
      {
        preventDefault: () => {},
        clientX: 100,
      } as unknown as React.PointerEvent,
      "right",
      200,
      setWidth,
    );
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 120 }));
    expect(setWidth).toHaveBeenLastCalledWith(220);
    window.dispatchEvent(new Event("pointercancel"));
    setWidth.mockClear();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 160 }));
    expect(setWidth).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
  });

  it("그룹 밖 저장 호스트만 재정렬해도 IPC 왕복 동안 그룹 멤버가 사라지지 않는다", async () => {
    const h = (alias: string) => ({
      alias,
      host: alias,
      port: 22,
      user: "u",
      key_path: null,
    });
    useSavedHosts.setState({ hosts: [h("a"), h("g"), h("b")] });
    const p = reorderSavedHosts(["b", "a"]);
    expect(useSavedHosts.getState().hosts.map((x) => x.alias)).toEqual([
      "b",
      "g",
      "a",
    ]);
    await p;
  });
});

describe("앱 런처 넘침", () => {
  it("앱이 많아도 '앱 추가' 버튼은 스크롤 영역 밖에 고정돼 항상 닿는다", () => {
    useAppLaunchers.setState({
      items: Array.from({ length: 30 }, (_, i) => ({
        id: `a${i}`,
        name: `App${i}`,
        path: `/Applications/App${i}.app`,
        args: [],
        children: null,
      })) as unknown as AppItem[],
    });
    render(<TopBar />);
    const add = screen.getByRole("button", { name: i18n.t("launcher.addApp") });
    const scroller = document.querySelector("[data-launcher-scroll]");
    expect(scroller).toBeTruthy();
    expect(scroller!.contains(add)).toBe(false);
    expect(scroller!.className).toContain("overflow-x-auto");
    expect(scroller!.querySelectorAll("button").length).toBe(30);
  });
});

describe("검증 1차 후속 (sol-2 F2~F6)", () => {
  const winKeys = vi.fn();
  beforeEach(() => {
    resetSidebarStores();
    useTasks.setState({ tasks: new Map(), cancelling: new Set() });
    useUIDialogs.setState({ dialog: { kind: "none" } });
    window.addEventListener("keydown", winKeys);
    winKeys.mockClear();
  });
  afterEach(() => window.removeEventListener("keydown", winKeys));

  it("사이드바 행의 Ctrl/⌘+Enter(반대 패널에 열기)는 패널 Enter 로 새지 않는다", async () => {
    useBookmarks.setState({
      items: [{ id: "b1", name: "work", location: local("/work") }],
    });
    useRecents.setState({
      items: [{ source: "local", path: "/projects", label: "projects" }],
    });
    await renderSidebar();
    fireEvent.keyDown(row("work"), { key: "Enter", ctrlKey: true });
    expect(sidebarProps.onOpenLocation).toHaveBeenCalledWith(
      local("/work"),
      "right",
    );
    // <button> 행(최근)도 같은 규칙.
    fireEvent.keyDown(row("projects"), { key: "Enter", metaKey: true });
    expect(winKeys).not.toHaveBeenCalled();
  });

  it("작업 바·상태바 버튼의 Enter/Space 는 패널 키 처리로 새지 않는다", () => {
    setTab("left", { entries: [mk(".env", { hidden: true })] });
    render(
      <>
        <TasksBar />
        <StatusBar />
      </>,
    );
    setTasks([task("big", "running")]);
    fireEvent.keyDown(screen.getByText("big.zip"), { key: "Enter" });
    fireEvent.keyDown(
      screen.getByRole("button", { name: i18n.t("sidebar.cancelTask") }),
      {
        key: " ",
      },
    );
    fireEvent.keyDown(
      screen.getByRole("button", {
        name: i18n.t("statusbar.hiddenCount", { count: 1 }),
      }),
      { key: "Enter" },
    );
    expect(winKeys).not.toHaveBeenCalled();
  });

  it("상단바 버튼을 마우스로 누르면 포커스를 내려놓는다 (Windows 에서 다음 Enter 가 버튼으로 가지 않게)", () => {
    useCommands.setState({ builtins: [cmd("view.togglePreview", "F11")] });
    render(<TopBar />);
    const btn = screen.getByRole("button", {
      name: i18n.t("topbar.togglePreview", { key: displayKey("F11") }),
    });
    btn.focus();
    fireEvent.click(btn, { detail: 1 });
    expect(document.activeElement).not.toBe(btn);
  });

  it("원격 폴더는 메타 크기(4 KiB) 대신 계산한 재귀 크기로 선택 용량을 센다", () => {
    setTab("left", {
      location: { source: sshSrc("prod:1"), path: "/srv" },
      entries: [
        mk("docs", { kind: "dir", size: 4096 }),
        mk("a.txt", { size: 0 }),
      ],
      dirSizes: { docs: 1048576 },
      selected: new Set(["docs"]),
    });
    render(<StatusBar />);
    expect(screen.getByText(/\(1(\.0)? MiB\)|\(1(\.0)? MB\)/)).toBeTruthy();
    // 합계(파일만)에 폴더 메타 크기가 섞이지 않는다 — 파일 0 B 이므로 합계 표시 없음.
    expect(screen.queryByText(/4(\.0)? KiB|4(\.0)? KB/)).toBeNull();
  });

  it("같은 호스트의 두 번째 연결을 보는 패널도 원격 즐겨찾기에 배지로 보인다", async () => {
    useConnections.setState({
      active: {
        "prod:1": conn("prod:1", "prod", "connected"),
        "prod:2": conn("prod:2", "prod", "connected"),
      },
    });
    useHostFavorites.setState({
      items: [{ id: "f1", host_alias: "prod", name: "logs", path: "/var/log" }],
    });
    setTab("left", {
      location: { source: sshSrc("prod:2"), path: "/var/log" },
    });
    await renderSidebar();
    expect(row("logs").textContent).toContain("L");
  });
});
