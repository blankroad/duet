import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ConnectionBanner } from "./ConnectionBanner";
import { usePanes } from "@/stores/panes";
import { useConnections } from "@/stores/connections";
import type { Location } from "@/types/bindings";

const m = vi.hoisted(() => ({ connectionClose: vi.fn() }));
vi.mock("@/types/bindings", () => ({ commands: m }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const ssh = (connection_id: string, path = "/srv"): Location => ({
  source: { kind: "ssh", connection_id, host_ip: "10.0.0.1", user: "u" },
  path,
});

/** 왼쪽 패널에 탭들을 놓고 index 를 활성으로. */
function setLeftTabs(locs: Location[], active = 0) {
  const st = usePanes.getState();
  // 기존 탭 하나를 첫 위치로 바꾸고 나머지는 openTab 으로.
  usePanes.setState({
    panes: {
      ...st.panes,
      left: {
        activeTabIndex: active,
        tabs: locs.map((location, i) => ({
          ...st.panes.left.tabs[0]!,
          id: `bt${i}`,
          location,
        })),
      },
    },
  });
}

describe("ConnectionBanner alias", () => {
  beforeEach(() => {
    useConnections.setState({ active: {}, hosts: [], reconnecting: {} });
  });

  it("uses the active tab's own host after switching tabs (no stale alias)", () => {
    useConnections.setState({
      active: {
        "a:1": {
          id: "a:1",
          alias: "a",
          host_ip: "10.0.0.1",
          user: "u",
          state: { kind: "error", message: "gone" },
        },
      },
    });
    setLeftTabs([ssh("a:1"), ssh("b:restored")]);
    const onReconnect = vi.fn();
    render(<ConnectionBanner id="left" onReconnect={onReconnect} />);
    act(() => usePanes.getState().selectTab("left", 1));
    fireEvent.click(screen.getByRole("button", { name: /banner.reconnect/ }));
    expect(onReconnect).toHaveBeenCalledWith("b", "left");
  });

  it("keeps the port of an ad-hoc alias from a restored tab", () => {
    setLeftTabs([ssh("root@1.2.3.4:22:restored")]);
    const onReconnect = vi.fn();
    render(<ConnectionBanner id="left" onReconnect={onReconnect} />);
    fireEvent.click(screen.getByRole("button", { name: /banner.reconnect/ }));
    expect(onReconnect).toHaveBeenCalledWith("root@1.2.3.4:22", "left");
  });

  it("offers Stop while the backend is auto-reconnecting", () => {
    useConnections.setState({
      reconnecting: {},
      active: {
        "a:1": {
          id: "a:1",
          alias: "a",
          host_ip: "10.0.0.1",
          user: "u",
          state: { kind: "connecting" },
        },
      },
    });
    setLeftTabs([ssh("a:1")]);
    render(<ConnectionBanner id="left" onReconnect={vi.fn()} />);
    expect(screen.getByText("banner.autoReconnecting")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "banner.stop" }));
    expect(m.connectionClose).toHaveBeenCalledWith("a:1");
  });

  it("shows progress without buttons during a banner reconnect", () => {
    useConnections.setState({ reconnecting: { b: true } });
    setLeftTabs([ssh("b:restored")]);
    render(<ConnectionBanner id="left" onReconnect={vi.fn()} />);
    expect(screen.getByText("banner.reconnecting")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("translates known supervisor reasons and keeps unknown ones as-is", () => {
    const at = (message: string) => {
      useConnections.setState({
        reconnecting: {},
        active: {
          "a:1": {
            id: "a:1",
            alias: "a",
            host_ip: "10.0.0.1",
            user: "u",
            state: { kind: "error", message },
          },
        },
      });
      setLeftTabs([ssh("a:1")]);
      const r = render(<ConnectionBanner id="left" onReconnect={vi.fn()} />);
      const text = screen.getByRole("alert").textContent;
      r.unmount();
      return text;
    };
    expect(at("auth failed on reconnect")).toContain(
      "banner.reason.authFailed",
    );
    expect(at("connection refused")).toContain("connection refused");
  });
});
