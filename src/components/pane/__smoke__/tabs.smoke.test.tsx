import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

import { Pane } from "../Pane";
import { ContextMenu } from "@/components/ContextMenu";
import { usePanes, type TabState } from "@/stores/panes";
import { useConnections } from "@/stores/connections";
import { useContextMenu } from "@/stores/contextMenu";
import { useToast } from "@/stores/toast";
import { clearClosedTabs } from "@/stores/closedTabs";
import { snapshot } from "@/stores/session";
import type { Location } from "@/types/bindings";
import i18n from "@/i18n";

// jsdom 에는 ResizeObserver 가 없다 — TabBar 의 활성 탭 노출 effect 용 no-op.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

/**
 * tabs 팀 사용자 시나리오 스모크 — 실제 Pane 트리(TabBar + PathBar + 배너)를 렌더하고
 * 클릭/우클릭/가운데 클릭으로 사용자가 겪는 흐름을 처음부터 끝까지 재현한다.
 * IPC 는 쓰지 않는다 (Pane 은 dumb component — 목록 로드는 App 몫).
 */

const local = (path: string): Location => ({
  source: { kind: "local" },
  path,
});
const ssh = (alias: string, path: string, suffix = "u1"): Location => ({
  source: {
    kind: "ssh",
    connection_id: `${alias}:${suffix}`,
    host_ip: "10.0.0.7",
    user: "deploy",
  },
  path,
});

/** 왼쪽 패널 탭을 통째로 설정 (오른쪽은 로컬 한 장). */
function setTabs(locs: Location[], active = 0, pinned: boolean[] = []) {
  const base = usePanes.getState().panes.left.tabs[0]!;
  const mk = (location: Location, i: number, pane: string): TabState => ({
    ...base,
    id: `${pane}${i}`,
    location,
    entries: [],
    selected: new Set(),
    history: { stack: [location], index: 0 },
    archive: undefined,
    trashRoot: undefined,
    pinned: pinned[i] ?? false,
  });
  usePanes.setState({
    activePane: "left",
    panes: {
      left: { tabs: locs.map((l, i) => mk(l, i, "L")), activeTabIndex: active },
      right: { tabs: [mk(local("/r"), 0, "R")], activeTabIndex: 0 },
    },
  });
}

const leftPaths = () =>
  usePanes.getState().panes.left.tabs.map((t) => String(t.location.path));

function renderPane() {
  const noop = vi.fn();
  return render(
    <>
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
      />
      <ContextMenu />
    </>,
  );
}

const tabEls = () => screen.getAllByRole("tab");
/** 열린 우클릭 메뉴의 항목 (메뉴 항목은 role 없는 button — 탭 안 버튼은 제외). */
const menuItem = (label: string | RegExp): HTMLButtonElement => {
  const hit = screen
    .getAllByRole("button")
    .filter((b) => !b.closest('[role="tab"]'))
    .find((b) =>
      typeof label === "string"
        ? b.textContent?.startsWith(label)
        : label.test(b.textContent ?? ""),
    );
  if (!hit) throw new Error(`menu item not found: ${String(label)}`);
  return hit as HTMLButtonElement;
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  clearClosedTabs();
  useToast.getState().clear();
  useConnections.setState({
    hosts: [],
    active: {
      "prod:u1": {
        id: "prod:u1",
        alias: "prod",
        host_ip: "10.0.0.7",
        user: "deploy",
        state: { kind: "connected" },
      },
    },
  });
});
afterEach(() => {
  cleanup();
  useContextMenu.getState().close();
});

describe("원격 식별 (사용자 지적 #1)", () => {
  it("원격 탭 1장 — 탭 바가 없어도 패널 헤더 칩에 호스트 이름이 보인다", () => {
    setTabs([ssh("prod", "/var/log")]);
    renderPane();
    expect(screen.queryByRole("tablist")).toBeNull();
    const chip = screen.getByTestId("source-chip");
    expect(chip!.textContent).toContain("prod");
    expect(chip.getAttribute("data-state")).toBe("connected");
    expect(chip.getAttribute("title")).toContain("deploy@10.0.0.7");
  });

  it("로컬 패널 칩은 조용하다 — 호스트 텍스트 없음", () => {
    setTabs([local("/home")]);
    renderPane();
    expect(screen.getByTestId("source-chip")!.textContent).toBe("");
  });

  it("탭 바에서 원격 탭은 호스트 이름을 달고, 비활성 탭의 끊김도 보인다", () => {
    setTabs([local("/var/log"), ssh("prod", "/var/log")], 0);
    renderPane();
    const [localTab, remoteTab] = tabEls();
    expect(localTab!.textContent).not.toContain("prod");
    expect(remoteTab!.textContent).toContain("prod");
    expect(remoteTab!.getAttribute("aria-label")).toContain("Connected");
    act(() =>
      useConnections
        .getState()
        .setState("prod:u1", { kind: "error", message: "broken pipe" }),
    );
    expect(tabEls()[1]!.getAttribute("aria-label")).toContain(
      "Connection error",
    );
    expect(tabEls()[1]!.getAttribute("title")).toContain("broken pipe");
  });

  it("재시작 복원 탭(미연결)은 alias 를 유지하고 끊김으로 표시된다", () => {
    setTabs([ssh("prod", "/srv", "restored")]);
    renderPane();
    const chip = screen.getByTestId("source-chip");
    expect(chip!.textContent).toContain("prod");
    expect(chip!.textContent).not.toContain("0.0.0.0");
    expect(chip.getAttribute("data-state")).toBe("disconnected");
  });

  it("경로 편집 중에도 칩이 남는다", () => {
    setTabs([ssh("prod", "/var/log")]);
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Edit path" }));
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.getByTestId("source-chip")!.textContent).toContain("prod");
  });
});

describe("핀 탭 (사용자 지적 #2)", () => {
  it("우클릭 → 탭 고정: 왼쪽으로 가고 X 대신 고정 해제 버튼", () => {
    setTabs([local("/a"), local("/b"), local("/c")], 2);
    renderPane();
    fireEvent.contextMenu(tabEls()[2]!);
    fireEvent.click(menuItem(/^Pin tab/));
    expect(leftPaths()).toEqual(["/c", "/a", "/b"]);
    const pinnedTab = tabEls()[0]!;
    expect(
      within(pinnedTab).getByRole("button", { name: "Unpin tab" }),
    ).toBeTruthy();
    expect(
      within(pinnedTab).queryByRole("button", { name: "Close tab" }),
    ).toBeNull();
    // 활성 탭(/c)은 그대로
    expect(tabEls()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("가운데 클릭으로 닫히지 않고 이유를 알린다", () => {
    setTabs([local("/a"), local("/b")], 1, [true, false]);
    renderPane();
    fireEvent(
      tabEls()[0]!,
      new MouseEvent("auxclick", { bubbles: true, button: 1 }),
    );
    expect(leftPaths()).toEqual(["/a", "/b"]);
    expect(useToast.getState().toasts.at(-1)?.message).toMatch(/Pinned/);
  });

  it("메뉴: 이 탭 닫기 비활성, 다른 탭 모두 닫기에서 살아남는다", () => {
    setTabs([local("/a"), local("/b"), local("/c")], 1, [true]);
    renderPane();
    fireEvent.contextMenu(tabEls()[0]!);
    expect(menuItem(/^Close tab/).disabled).toBe(true);
    act(() => useContextMenu.getState().close());
    fireEvent.contextMenu(tabEls()[2]!);
    fireEvent.click(menuItem("Close other tabs"));
    expect(leftPaths()).toEqual(["/a", "/c"]);
  });

  it("핀이 있으면 '고정 안 된 탭 모두 닫기' — 핀만 남는다", () => {
    setTabs([local("/a"), local("/b"), local("/c")], 2, [true]);
    renderPane();
    fireEvent.contextMenu(tabEls()[1]!);
    fireEvent.click(menuItem("Close unpinned tabs"));
    expect(leftPaths()).toEqual(["/a"]);
    // 핀 한 장만 남아도 탭 바는 보인다 (고정 상태·해제 버튼이 보여야 함)
    expect(screen.getByRole("tablist")).toBeTruthy();
  });

  it("고정 해제 버튼 → 일반 탭으로 돌아가고 탭 1장이면 탭 바가 숨는다", () => {
    setTabs([local("/a")], 0, [true]);
    renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Unpin tab" }));
    expect(usePanes.getState().panes.left.tabs[0]!.pinned).toBe(false);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("세션 저장에 핀이 실리고 복원하면 핀 탭으로 돌아온다", () => {
    setTabs([local("/a"), local("/b")], 1, [true]);
    const saved = snapshot();
    setTabs([local("/x")]);
    act(() => usePanes.getState().restoreLayout(saved));
    renderPane();
    expect(leftPaths()).toEqual(["/a", "/b"]);
    expect(
      within(tabEls()[0]!).getByRole("button", { name: "Unpin tab" }),
    ).toBeTruthy();
  });
});

describe("일반 탭 UX", () => {
  it("X 로 닫은 탭을 메뉴의 '닫은 탭 다시 열기'로 제자리에 되살린다", () => {
    setTabs([local("/a"), local("/b"), local("/c")], 1);
    renderPane();
    fireEvent.click(
      within(tabEls()[1]!).getByRole("button", { name: "Close tab" }),
    );
    expect(leftPaths()).toEqual(["/a", "/c"]);
    fireEvent.contextMenu(tabEls()[0]!);
    fireEvent.click(menuItem(/^Reopen closed tab/));
    expect(leftPaths()).toEqual(["/a", "/b", "/c"]);
  });

  it("복제는 원본 바로 오른쪽에 생긴다", () => {
    setTabs([local("/a"), local("/b"), local("/c")], 2);
    renderPane();
    fireEvent.contextMenu(tabEls()[0]!);
    fireEvent.click(menuItem("Duplicate tab"));
    expect(leftPaths()).toEqual(["/a", "/a", "/b", "/c"]);
    expect(usePanes.getState().panes.left.activeTabIndex).toBe(1);
  });

  it("아카이브를 보는 탭 제목은 임시 폴더가 아니라 아카이브 이름", () => {
    setTabs([local("/a"), local("/tmp/duet-archive/k/content")], 1);
    act(() =>
      usePanes.getState().setArchiveContext("left", {
        label: "logs.zip",
        root: "/tmp/duet-archive/k/content",
        exitTo: local("/a"),
      }),
    );
    renderPane();
    expect(tabEls()[1]!.textContent).toContain("logs.zip");
    expect(tabEls()[1]!.textContent).not.toContain("content");
  });

  it("끌어서 순서 변경 — 일반 탭은 핀 앞으로 가지 못한다", () => {
    setTabs([local("/a"), local("/b"), local("/c")], 0, [true]);
    renderPane();
    const [a, , c] = tabEls();
    // jsdom 에는 레이아웃이 없다 — 포인터 아래 요소를 /a 탭의 왼쪽 절반으로 고정.
    const orig = document.elementFromPoint;
    document.elementFromPoint = () => a!;
    a!.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 100, height: 20 }) as DOMRect;
    try {
      fireEvent.mouseDown(c!, { button: 0, clientX: 250, clientY: 10 });
      fireEvent.mouseMove(window, { clientX: 10, clientY: 10 });
      fireEvent.mouseUp(window, { clientX: 10, clientY: 10 });
    } finally {
      document.elementFromPoint = orig;
    }
    expect(leftPaths()).toEqual(["/a", "/c", "/b"]);
  });
});

describe("탭 명령 등록 (팔레트·키맵)", () => {
  it("고정·다시 열기·좌우 이동이 키맵에 등록된다 — 고정은 기본 키 없음", async () => {
    const { buildBuiltins } = await import("@/lib/commands");
    const deps = new Proxy({}, { get: () => () => {} }) as Parameters<
      typeof buildBuiltins
    >[0];
    const byId = new Map(buildBuiltins(deps).map((c) => [c.id, c]));
    expect(byId.get("tab.togglePin")?.defaultKey).toBeUndefined();
    expect(byId.get("tab.reopenClosed")?.defaultKey).toBe("Ctrl+Shift+T");
    expect(byId.get("tab.moveLeft")?.defaultKey).toBe("Ctrl+Shift+PageUp");
    expect(byId.get("tab.moveRight")?.defaultKey).toBe("Ctrl+Shift+PageDown");
    // 다른 명령과 기본 키가 겹치지 않는다
    const keys = [...byId.values()]
      .map((c) => c.defaultKey)
      .filter((k): k is string => !!k);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
