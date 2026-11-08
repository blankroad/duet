import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * browse 점검 R1 (opus) — C-17 끊긴 원격 패널 표시.
 * "빈 폴더입니다" 는 지난 라운드에 이미 알려짐 — 현재 코드에서 재현되는지 고정(it.fails).
 */

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

import { Pane } from "../Pane";
import { usePanes, RESTORED_CONN, type TabState } from "@/stores/panes";
import { useConnections } from "@/stores/connections";
import type { Location } from "@/types/bindings";
import i18n from "@/i18n";

const ssh = (connection_id: string, path: string): Location => ({
  source: { kind: "ssh", connection_id, host_ip: "10.0.0.7", user: "deploy" },
  path,
});

function setLeft(location: Location, entries: TabState["entries"] = []) {
  const base = usePanes.getState().panes.left.tabs[0]!;
  const tab: TabState = {
    ...base,
    id: "D0",
    location,
    entries,
    loading: false,
    filter: "",
    selected: new Set(),
    history: { stack: [location], index: 0 },
  };
  usePanes.setState({
    activePane: "left",
    panes: {
      left: { tabs: [tab], activeTabIndex: 0 },
      right: usePanes.getState().panes.right,
    },
  });
}

function renderPane() {
  const noop = vi.fn();
  return render(
    <Pane
      id="left"
      onNavigate={noop}
      onActivate={noop}
      onRefresh={noop}
      onBack={noop}
      onForward={noop}
      onUp={noop}
      onEntryContextMenu={noop}
      onEmptyContextMenu={noop}
      onUpdateArchive={noop}
      onReconnect={noop}
    />,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  useConnections.setState({ hosts: [], active: {} });
});
afterEach(cleanup);

describe("C-17 끊긴 원격 패널", () => {
  it("재시작 복원 원격 탭: 배너는 뜬다", () => {
    setLeft(ssh(`prod:${RESTORED_CONN}`, "/srv"));
    renderPane();
    expect(screen.getByRole("alert").textContent).toMatch(/prod/);
  });

  it.fails(
    "browse-15 이미 알려짐: 재시작 복원 원격 탭 본문에 'This folder is empty' 가 함께 보인다",
    () => {
      setLeft(ssh(`prod:${RESTORED_CONN}`, "/srv"));
      renderPane();
      expect(screen.queryByText("This folder is empty")).toBeNull();
    },
  );

  it.fails(
    "browse-15 이미 알려짐(변형): 연결이 오류로 끊긴 탭에서 목록이 비어 있으면 'This folder is empty'",
    () => {
      useConnections.setState({
        hosts: [],
        active: {
          "prod:u1": {
            id: "prod:u1",
            alias: "prod",
            host_ip: "10.0.0.7",
            user: "deploy",
            state: { kind: "error", message: "connection reset" },
          },
        },
      });
      setLeft(ssh("prod:u1", "/srv"));
      renderPane();
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.queryByText("This folder is empty")).toBeNull();
    },
  );

  it("끊겼어도 이전 목록이 남아 있으면 그대로 보인다 (항목은 조작 가능 상태)", () => {
    useConnections.setState({ hosts: [], active: {} });
    setLeft(ssh("prod:u1", "/srv"), [
      {
        name: "app",
        kind: "dir",
        size: null,
        modified_ms: 1,
        permissions: null,
        hidden: false,
      },
    ]);
    renderPane();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByText("This folder is empty")).toBeNull();
  });
});
