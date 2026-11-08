/**
 * review/remote (opus R1) — C-10 배너 재연결 뒤 남는 예전 connection_id.
 *
 * 배너 [재연결]은 백엔드에서 **새** connection_id 를 받는다. `rebindHostTabs` 는 탭(현재 위치·
 * 기록·아카이브 복귀)만 새 id 로 바꾼다. 같은 세션 메모리에 원격 위치를 들고 있는 다른 곳 —
 * 인앱 클립보드(Ctrl+C/X), 선반(Shelf) — 은 그대로 예전 id 를 가리킨다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { usePanes, type TabState } from "@/stores/panes";
import { useConnections, type ActiveConnection } from "@/stores/connections";
import { useClipboard } from "@/stores/clipboard";
import { useShelf } from "@/stores/shelf";
import type { EntryRef, Location } from "@/types/bindings";

const m = vi.hoisted(() => ({
  connectionOpen: vi.fn(),
  connectionOpenAdhoc: vi.fn(),
  connectionClose: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({ commands: m }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import {
  pruneDeadConnections,
  rebindHostTabs,
  type SshSource,
} from "@/stores/reconnect";
import { ConnectionBanner } from "@/components/pane/ConnectionBanner";

const ssh = (connection_id: string, path = "/srv"): Location => ({
  source: { kind: "ssh", connection_id, host_ip: "10.0.0.1", user: "u" },
  path,
});
const ref = (connection_id: string, name: string): EntryRef => ({
  location: ssh(connection_id, "/srv/data"),
  name,
});
const conn = (
  id: string,
  alias: string,
  state: ActiveConnection["state"],
): ActiveConnection => ({ id, alias, host_ip: "10.0.0.1", user: "u", state });

function tabsOf(locs: Location[]): TabState[] {
  const base = usePanes.getState().panes.left.tabs[0]!;
  return locs.map((location, i) => ({
    ...base,
    id: `t${i}`,
    location,
    history: { stack: [location], index: 0 },
  }));
}

const fresh: SshSource = {
  kind: "ssh",
  connection_id: "nas:new",
  host_ip: "10.0.0.1",
  user: "u",
};

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  useConnections.setState({
    active: {
      "nas:old": conn("nas:old", "nas", {
        kind: "error",
        message: "auth failed on reconnect",
      }),
    },
    hosts: [],
    reconnecting: {},
  });
  usePanes.setState({
    panes: {
      left: { activeTabIndex: 0, tabs: tabsOf([ssh("nas:old", "/srv/data")]) },
      right: { activeTabIndex: 0, tabs: tabsOf([ssh("nas:old", "/srv")]) },
    },
  });
  useClipboard.setState({ entry: null });
  useShelf.getState().clear();
});

describe("remote-opus C-10: 재연결 뒤 예전 connection_id 잔존", () => {
  it("탭은 새 id 로 다시 묶인다 (기준선)", () => {
    const r = rebindHostTabs("nas", fresh);
    expect(r.tabs).toBe(2);
    const src = usePanes.getState().panes.left.tabs[0]!.location.source;
    expect(src.kind === "ssh" && src.connection_id).toBe("nas:new");
  });

  it.fails("remote-10: 잘라내기(Ctrl+X) 해 둔 원격 항목은 재연결 뒤에도 새 id 로 붙여넣을 수 있어야 한다", () => {
    // 끊기기 전에 원격 파일을 잘라내기 → 연결 끊김 → 배너 재연결.
    useClipboard.getState().set([ref("nas:old", "report.pdf")], "move");
    rebindHostTabs("nas", fresh);
    pruneDeadConnections("nas");

    const target = useClipboard.getState().entry!.targets[0]!.location.source;
    // 실제: "nas:old" 그대로 → 붙여넣기 IPC 가 `no connection: nas:old` 로 실패.
    expect(target.kind === "ssh" && target.connection_id).toBe("nas:new");
  });

  it.fails("remote-10: 선반에 담아 둔 원격 항목도 재연결 뒤 새 id 를 가리켜야 한다", () => {
    useShelf.getState().add([ref("nas:old", "a.log"), ref("nas:old", "b.log")]);
    rebindHostTabs("nas", fresh);
    pruneDeadConnections("nas");
    const ids = useShelf
      .getState()
      .sections.flatMap((s) => s.items)
      .map((i) =>
        i.location.source.kind === "ssh" ? i.location.source.connection_id : "local",
      );
    expect(ids).toEqual(["nas:new", "nas:new"]);
  });
});

describe("remote-opus C-11: 자동 재연결 실패 사유 표시", () => {
  it("remote-26 관찰: supervisor 의 원문(네트워크 오류)은 번역 없이 그대로 배너에 보인다", () => {
    // connection_supervisor.rs 의 마지막 시도 실패: final_failure(..., &format!("{e}"))
    useConnections.setState({
      active: {
        "nas:old": conn("nas:old", "nas", {
          kind: "error",
          message: "connection failed: tcp connect 10.0.0.1:22: Connection refused (os error 61)",
        }),
      },
    });
    render(<ConnectionBanner id="left" onReconnect={() => {}} />);
    const alert = screen.getByRole("alert");
    // 관찰용: 고정 사유 4개만 i18n 매핑, 나머지는 영어 원문이 그대로 노출된다.
    expect(alert.textContent).toContain("Connection refused (os error 61)");
  });
});
