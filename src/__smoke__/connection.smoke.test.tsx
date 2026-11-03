/**
 * connection 스모크 — 실제 App 트리를 렌더하고 Tauri IPC 만 mockIPC 로 흉내 낸다.
 * 사용자 시나리오: 패널 배너의 "재연결" 이 그 패널·그 탭·그 경로로 돌아오는가.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
  act,
  cleanup,
} from "@testing-library/react";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";

vi.hoisted(() => {
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: "macos",
    os_type: "macos",
    eol: "\n",
  };
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

import i18n from "@/i18n";
import App from "@/App";
import { usePanes, type TabState } from "@/stores/panes";
import { useConnections } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import { useVault } from "@/stores/vault";
import type { Location } from "@/types/bindings";

/** 매 테스트를 같은 빈 레이아웃에서 시작 (store 는 모듈 전역이라 테스트 사이에 남는다). */
const initialPanes = usePanes.getState();

type Payload = Record<string, unknown> | undefined;
type Handler = (payload: Payload) => unknown;

let handlers: Record<string, Handler> = {};
let calls: Array<{ cmd: string; payload: Payload }> = [];

function installIpc() {
  mockWindows("main");
  mockIPC(
    (cmd, payload) => {
      calls.push({ cmd, payload: payload as Payload });
      const h = handlers[cmd];
      if (h) return h(payload as Payload);
      if (cmd === "home_directory") return "/Users/me";
      if (cmd === "list_directory") return [];
      if (cmd === "ssh_home_directory") return "/home/u";
      if (cmd === "ssh_config_hosts")
        return [
          {
            alias: "nas",
            hostname: "nas.lan",
            port: 22,
            user: "u",
            has_proxy_jump: false,
          },
        ];
      if (cmd.endsWith("_list") || cmd === "undo_history") return [];
      if (cmd === "vault_status") return { exists: false, unlocked: false };
      if (cmd.startsWith("plugin:") || cmd === "pane_watch_set") return null;
      throw { kind: "NotSupported", message: `mock: ${cmd}` };
    },
    { shouldMockEvents: true },
  );
}

const ssh = (connection_id: string, path: string): Location => ({
  source: { kind: "ssh", connection_id, host_ip: "10.0.0.1", user: "u" },
  path,
});
const local = (path: string): Location => ({ source: { kind: "local" }, path });

function tabsOf(locs: Location[]): TabState[] {
  const base = usePanes.getState().panes.left.tabs[0]!;
  return locs.map((location, i) => ({
    ...base,
    id: `smoke-${String(location.path)}-${i}`,
    location,
    entries: [],
    history: { stack: [location], index: 0 },
  }));
}

/** 끊긴 nas 세션: 왼쪽 활성 탭과 오른쪽 2번째(활성) 탭이 같은 죽은 연결을 쓴다. */
function seedDeadNas() {
  useConnections.setState({
    active: {
      "nas:old": {
        id: "nas:old",
        alias: "nas",
        host_ip: "10.0.0.1",
        user: "u",
        state: { kind: "error", message: "keepalive timeout" },
      },
    },
  });
  usePanes.setState({
    activePane: "left",
    panes: {
      left: { activeTabIndex: 0, tabs: tabsOf([ssh("nas:old", "/home/u")]) },
      right: {
        activeTabIndex: 1,
        tabs: tabsOf([local("/tmp"), ssh("nas:old", "/srv/data")]),
      },
    },
  });
}

const connId = (loc: Location) =>
  loc.source.kind === "ssh" ? loc.source.connection_id : "local";
const rightTab = () => {
  const p = usePanes.getState().panes.right;
  return p.tabs[p.activeTabIndex]!;
};
const leftTab = () => {
  const p = usePanes.getState().panes.left;
  return p.tabs[p.activeTabIndex]!;
};

async function renderApp() {
  render(<App />);
  // 부트스트랩(홈 목록·호스트 목록 로드)이 끝날 때까지.
  await waitFor(() =>
    expect(useConnections.getState().hosts.map((h) => h.alias)).toContain(
      "nas",
    ),
  );
  // 양쪽 패널의 홈 목록 적용까지 — 늦게 끝난 부트스트랩 이동이 시드한 탭을 덮지 않게.
  await waitFor(() => {
    const { left, right } = usePanes.getState().panes;
    expect(left.tabs[0]!.location.path).toBe("/Users/me");
    expect(right.tabs[0]!.location.path).toBe("/Users/me");
    expect(left.tabs[0]!.loading || right.tabs[0]!.loading).toBe(false);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

/** 패널 배너의 재연결 버튼들 (DOM 순서 = 왼쪽, 오른쪽). */
const reconnectButtons = () =>
  screen.queryAllByRole("button", { name: /^Reconnect$/ });

beforeEach(async () => {
  // 앞 테스트가 저장한 세션(탭 레이아웃)이 복원되면 부트스트랩 이동이 늦게 끝나
  // 시드한 탭을 덮는다 — 매번 빈 세션으로 시작.
  try {
    localStorage.clear();
  } catch {
    // jsdom 저장소가 없으면 무시
  }
  usePanes.setState({
    panes: initialPanes.panes,
    activePane: initialPanes.activePane,
  });
  await i18n.changeLanguage("en");
  handlers = {};
  calls = [];
  useSavedHosts.setState({ hosts: [] });
  useVault.setState({ exists: false, unlocked: false });
  useConnections.setState({ active: {}, reconnecting: {} });
  installIpc();
});

afterEach(async () => {
  cleanup();
  // 언마운트한 리스너의 unlisten 은 비동기 — 끝난 뒤에 mock 을 걷는다.
  await new Promise((r) => setTimeout(r, 0));
  clearMocks();
});

describe("connection smoke: banner reconnect", () => {
  it("key-auth host: right pane's 2nd tab comes back in place, no dialog, and the left tab revives too", async () => {
    handlers.connection_open = () => ({
      id: "nas:new",
      alias: "nas",
      host_ip: "10.0.0.2",
      user: "u",
    });
    await renderApp();
    act(() => seedDeadNas());

    const buttons = reconnectButtons();
    expect(buttons).toHaveLength(2); // 양쪽 패널 모두 끊김 배너
    fireEvent.click(buttons[1]!); // 오른쪽 패널

    await waitFor(() => expect(connId(rightTab().location)).toBe("nas:new"));
    // 대화상자 없이 붙었다 — 패널 선택을 다시 묻지 않는다.
    expect(screen.queryByText("Open in pane")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const open = calls.find((c) => c.cmd === "connection_open");
    expect(open?.payload).toMatchObject({
      alias: "nas",
      password: null,
      trustHostKey: false,
    });
    // 같은 탭(2번째), 같은 경로.
    expect(usePanes.getState().panes.right.activeTabIndex).toBe(1);
    expect(rightTab().location.path).toBe("/srv/data");
    // 왼쪽 패널의 같은 호스트 탭도 새 연결로, 경로 유지.
    expect(connId(leftTab().location)).toBe("nas:new");
    expect(leftTab().location.path).toBe("/home/u");
    // 그 경로를 새 연결로 읽고 감시자도 옮겼다. 홈 조회는 필요 없었다.
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "pane_watch_set" &&
            (c.payload?.location as Location | undefined)?.path === "/srv/data",
        ),
      ).toBe(true),
    );
    expect(calls.some((c) => c.cmd === "ssh_home_directory")).toBe(false);
    // 배너가 사라졌다.
    await waitFor(() => expect(reconnectButtons()).toHaveLength(0));
  });

  it("while reconnecting both banners show progress and the button is gone (no double connect)", async () => {
    let finish!: (v: unknown) => void;
    handlers.connection_open = () => new Promise((r) => (finish = r));
    await renderApp();
    act(() => seedDeadNas());

    fireEvent.click(reconnectButtons()[0]!);
    await waitFor(() =>
      expect(screen.getAllByText("Reconnecting to nas…")).toHaveLength(2),
    );
    expect(reconnectButtons()).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "connection_open")).toHaveLength(1);

    await act(async () =>
      finish({ id: "nas:new", alias: "nas", host_ip: "10.0.0.2", user: "u" }),
    );
    await waitFor(() => expect(connId(leftTab().location)).toBe("nas:new"));
  });

  it("password host: the dialog opens pinned to that pane with the reason, then returns to the tab", async () => {
    let n = 0;
    handlers.connection_open = (p) => {
      n += 1;
      if (n === 1) throw { kind: "AuthFailed" };
      expect(p?.password).toBe("pw");
      return { id: "nas:new", alias: "nas", host_ip: "10.0.0.2", user: "u" };
    };
    await renderApp();
    act(() => seedDeadNas());
    fireEvent.click(reconnectButtons()[1]!);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Reconnect to nas")).toBeTruthy();
    expect(within(dialog).queryByText("Open in pane")).toBeNull();
    expect(
      within(dialog).getByText(
        "Returns to the same tab in the Right pane once connected",
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText("Authentication failed")).toBeTruthy();

    // 그사이 사용자가 오른쪽 패널의 다른 탭으로 옮겨도 버튼이 있던 탭으로 돌아온다.
    act(() => usePanes.getState().selectTab("right", 0));
    fireEvent.change(within(dialog).getByLabelText(/Password/), {
      target: { value: "pw" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Connect/ }));

    await waitFor(() => expect(connId(rightTab().location)).toBe("nas:new"));
    expect(usePanes.getState().panes.right.activeTabIndex).toBe(1);
    expect(rightTab().location.path).toBe("/srv/data");
    expect(usePanes.getState().panes.right.tabs[0]!.location.path).toBe("/tmp");
  });

  it("restored ad-hoc tab: reconnects with the saved vault password by alias, port intact", async () => {
    handlers.connection_open_adhoc = () => ({
      id: "u@box.lan:2222:n1",
      alias: "u@box.lan:2222",
      host_ip: "10.0.0.3",
      user: "u",
    });
    await renderApp();
    act(() => {
      useSavedHosts.setState({
        hosts: [
          {
            alias: "box",
            host: "box.lan",
            port: 2222,
            user: "u",
            key_path: null,
          },
        ],
      });
      useVault.setState({ exists: true, unlocked: true });
      usePanes.setState({
        panes: {
          left: {
            activeTabIndex: 0,
            tabs: tabsOf([ssh("u@box.lan:2222:restored", "/data")]),
          },
          right: { activeTabIndex: 0, tabs: tabsOf([local("/tmp")]) },
        },
      });
    });
    expect(screen.getByText(/Not connected/)).toBeTruthy();
    fireEvent.click(reconnectButtons()[0]!);

    await waitFor(() =>
      expect(connId(leftTab().location)).toBe("u@box.lan:2222:n1"),
    );
    const req = calls.find((c) => c.cmd === "connection_open_adhoc");
    expect(req?.payload?.params).toMatchObject({
      host: "box.lan",
      port: 2222,
      password: null,
      savedPasswordAlias: "box",
    });
    expect(leftTab().location.path).toBe("/data");
  });

  it("server unreachable: no dialog, an error toast, and the banner stays for another try", async () => {
    handlers.connection_open = () => {
      throw { kind: "ConnectionFailed", message: "connection refused" };
    };
    await renderApp();
    act(() => seedDeadNas());
    fireEvent.click(reconnectButtons()[0]!);
    await waitFor(() =>
      expect(screen.getByText(/Couldn't reconnect to nas/)).toBeTruthy(),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(reconnectButtons()).toHaveLength(2);
  });
});

/** 지연 응답 — 테스트가 원하는 순간에 IPC 결과를 돌려준다. */
function later<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const listedPath = (p: Payload) => (p?.location as Location | undefined)?.path;
const listedConn = (p: Payload) => {
  const l = p?.location as Location | undefined;
  return l ? connId(l) : "";
};

describe("connection smoke: reconnect races", () => {
  it("two hosts reconnecting at once each return to their own path", async () => {
    const opens: Record<string, ReturnType<typeof later<unknown>>> = {};
    handlers.ssh_config_hosts = () =>
      ["nas", "web"].map((alias) => ({
        alias,
        hostname: `${alias}.lan`,
        port: 22,
        user: "u",
        has_proxy_jump: false,
      }));
    handlers.connection_open = (p) => {
      const d = later<unknown>();
      opens[String(p?.alias)] = d;
      return d.promise;
    };
    await renderApp();
    act(() => {
      useConnections.setState({
        active: {
          "nas:old": {
            id: "nas:old",
            alias: "nas",
            host_ip: "10.0.0.1",
            user: "u",
            state: { kind: "error", message: "x" },
          },
          "web:old": {
            id: "web:old",
            alias: "web",
            host_ip: "10.0.0.1",
            user: "u",
            state: { kind: "error", message: "x" },
          },
        },
      });
      usePanes.setState({
        panes: {
          left: {
            activeTabIndex: 0,
            tabs: tabsOf([ssh("nas:old", "/srv/nas")]),
          },
          right: {
            activeTabIndex: 0,
            tabs: tabsOf([ssh("web:old", "/srv/web")]),
          },
        },
      });
    });
    const [l, r] = reconnectButtons();
    fireEvent.click(l!);
    fireEvent.click(r!);
    await waitFor(() =>
      expect(Object.keys(opens).sort()).toEqual(["nas", "web"]),
    );
    await act(async () =>
      opens.nas!.resolve({
        id: "nas:new",
        alias: "nas",
        host_ip: "10.0.0.2",
        user: "u",
      }),
    );
    await act(async () =>
      opens.web!.resolve({
        id: "web:new",
        alias: "web",
        host_ip: "10.0.0.3",
        user: "u",
      }),
    );
    await waitFor(() => {
      expect(connId(leftTab().location)).toBe("nas:new");
      expect(connId(rightTab().location)).toBe("web:new");
    });
    expect(leftTab().location.path).toBe("/srv/nas");
    expect(rightTab().location.path).toBe("/srv/web");
  });

  it("closing the original tab while its listing loads leaves the remaining tab alone", async () => {
    const listing = later<unknown>();
    handlers.connection_open = () => ({
      id: "nas:new",
      alias: "nas",
      host_ip: "10.0.0.2",
      user: "u",
    });
    handlers.list_directory = (p) =>
      listedConn(p) === "nas:new" ? listing.promise : [];
    await renderApp();
    act(() => {
      useConnections.setState({
        active: {
          "nas:old": {
            id: "nas:old",
            alias: "nas",
            host_ip: "10.0.0.1",
            user: "u",
            state: { kind: "error", message: "x" },
          },
        },
      });
      usePanes.setState({
        panes: {
          left: { activeTabIndex: 0, tabs: tabsOf([local("/tmp")]) },
          right: {
            activeTabIndex: 0,
            tabs: tabsOf([ssh("nas:old", "/srv/data"), local("/spare-local")]),
          },
        },
      });
    });
    fireEvent.click(reconnectButtons()[0]!);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "list_directory" && listedConn(c.payload) === "nas:new",
        ),
      ).toBe(true),
    );
    act(() => usePanes.getState().closeTab("right", 0));
    await act(async () => listing.resolve([]));
    expect(rightTab().location).toEqual(local("/spare-local"));
    expect(calls.some((c) => c.cmd === "ssh_home_directory")).toBe(false);
  });

  it("after the user switches tabs, a failed listing does not start the home fallback", async () => {
    const listing = later<unknown>();
    handlers.connection_open = () => ({
      id: "nas:new",
      alias: "nas",
      host_ip: "10.0.0.2",
      user: "u",
    });
    handlers.list_directory = (p) =>
      listedConn(p) === "nas:new" && listedPath(p) === "/srv/data"
        ? listing.promise
        : [];
    await renderApp();
    act(() => seedDeadNas());
    // 왼쪽은 로컬로 바꿔 둬서 오른쪽 배너만 남긴다.
    act(() =>
      usePanes.setState((s) => ({
        panes: {
          ...s.panes,
          left: { activeTabIndex: 0, tabs: tabsOf([local("/Users/me")]) },
        },
      })),
    );
    fireEvent.click(reconnectButtons()[0]!);
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.cmd === "list_directory" && listedPath(c.payload) === "/srv/data",
        ),
      ).toBe(true),
    );
    act(() => usePanes.getState().selectTab("right", 0)); // 로컬 /tmp 탭으로
    await act(async () =>
      listing.reject({ kind: "NotFound", message: "gone" }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(rightTab().location).toEqual(local("/tmp"));
    expect(calls.some((c) => c.cmd === "ssh_home_directory")).toBe(false);
  });

  it("follows the original tab when it is moved to the other pane mid-reconnect", async () => {
    const open = later<unknown>();
    handlers.connection_open = () => open.promise;
    await renderApp();
    act(() => seedDeadNas());
    fireEvent.click(reconnectButtons()[1]!);
    await waitFor(() =>
      expect(calls.some((c) => c.cmd === "connection_open")).toBe(true),
    );
    act(() => {
      usePanes.getState().setActivePane("right");
      usePanes.getState().moveActiveTabToOther();
    });
    await act(async () =>
      open.resolve({
        id: "nas:new",
        alias: "nas",
        host_ip: "10.0.0.2",
        user: "u",
      }),
    );
    await waitFor(() => {
      const all = [
        ...usePanes.getState().panes.left.tabs,
        ...usePanes.getState().panes.right.tabs,
      ].filter((t) => t.location.path === "/srv/data");
      expect(all).toHaveLength(1);
      expect(connId(all[0]!.location)).toBe("nas:new");
    });
  });
});
