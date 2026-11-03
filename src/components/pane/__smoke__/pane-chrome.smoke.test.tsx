/**
 * pane-chrome 사용자 시나리오 스모크 — 실제 Pane 트리(TabBar·PathBar·툴바·필터/패턴 바·목록)와
 * 실제 zustand store·전역 키보드 내비(useKeyboardNav)를 렌더하고 클릭/키보드로 끝까지 재현한다.
 * Tauri IPC·OS 플러그인·파일 작업은 모킹(실제 파일시스템/원격 접근 없음).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Pane } from "../Pane";
import { ContextMenu } from "@/components/ContextMenu";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  type PaneId,
} from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useContextMenu } from "@/stores/contextMenu";
import type { Entry } from "@/types/bindings";
import i18n from "@/i18n";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/lib/fileActions", () => ({
  triggerMkdir: vi.fn(),
  triggerNewFile: vi.fn(),
  triggerCopy: vi.fn(),
  triggerMove: vi.fn(),
  triggerDelete: vi.fn(),
}));

const entry = (name: string, kind: "dir" | "file", hidden = false, mtime = 0) =>
  ({
    name,
    kind,
    size: 10,
    modified_ms: mtime,
    permissions: null,
    hidden,
  }) as Entry;

const ENTRIES = [
  entry(".config", "dir", true, 5),
  entry("src", "dir", false, 4),
  entry("app.log", "file", false, 3),
  entry("readme.md", "file", false, 2),
  entry(".env", "file", true, 1),
];

const noop = () => {};
function Harness({ id }: { id: PaneId }) {
  useKeyboardNav(noop, noop, noop);
  return (
    <>
      <Pane
        id={id}
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
    </>
  );
}

const tab = () => activeTab(usePanes.getState(), "right");
const names = () => computeDisplayed(tab()).map((e) => e.name);
const cursorName = () => computeDisplayed(tab())[tab().cursorIndex]?.name;

beforeEach(async () => {
  await i18n.changeLanguage("ko");
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const s = usePanes.getState();
  s.setActivePane("left");
  s.setEntries(
    "right",
    { source: { kind: "local" }, path: "/work/proj" },
    ENTRIES,
  );
  s.setFilter("right", "");
  s.setFilterFocused("right", false);
  s.setViewMode("right", "details");
  s.setSort("right", "name", "asc");
  if (tab().showHidden) s.toggleShowHidden("right");
  useUI.setState({ syncBrowse: false });
});
afterEach(() => {
  cleanup();
  useContextMenu.getState().close();
  vi.unstubAllGlobals();
});

describe("pane-chrome 스모크", () => {
  it("① 툴바에서 한 번 클릭으로 숨김 파일을 켜고 끈다 (상태가 보이고 커서가 유지된다)", () => {
    render(<Harness id="right" />);
    act(() =>
      usePanes.getState().setCursor("right", names().indexOf("readme.md")),
    );
    expect(names()).not.toContain(".env");
    const btn = screen.getByRole("button", { name: "숨김 파일" });
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(names()).toContain(".env");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.title).toMatch(/숨김 파일 숨기기/);
    expect(cursorName()).toBe("readme.md");
    expect(usePanes.getState().activePane).toBe("right");
    fireEvent.click(btn);
    expect(names()).not.toContain(".env");
    expect(cursorName()).toBe("readme.md");
  });

  it("② 필터 버튼 → 입력 → Enter → 방향키로 목록 커서가 움직인다", () => {
    render(<Harness id="right" />);
    fireEvent.click(screen.getByRole("button", { name: "이름 필터" }));
    const input = screen.getByRole("textbox", { name: "이름 필터" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "." } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).not.toBe(input);
    expect(names()).toEqual(["app.log", "readme.md"]);
    act(() => usePanes.getState().setCursor("right", 0));
    fireEvent.keyDown(document.activeElement ?? window, { key: "ArrowDown" });
    expect(cursorName()).toBe("readme.md");
    // 필터가 걸린 동안 툴바 버튼이 눌린 상태로 보인다.
    expect(
      screen
        .getByRole("button", { name: "이름 필터" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("③ 그리드 보기에서 툴바 정렬 메뉴로 기준·방향을 바꾼다", () => {
    render(<Harness id="right" />);
    act(() => usePanes.getState().setViewMode("right", "grid"));
    fireEvent.click(
      screen.getByRole("button", { name: "정렬: 이름 · 오름차순" }),
    );
    fireEvent.click(screen.getByText("수정일"));
    expect(tab().sortKey).toBe("mtime");
    expect(tab().sortOrder).toBe("desc");
    fireEvent.click(
      screen.getByRole("button", { name: "정렬: 수정일 · 내림차순" }),
    );
    fireEvent.click(screen.getByText("오름차순"));
    expect(tab().sortOrder).toBe("asc");
  });

  it("④ 경로 바: 현재 폴더 클릭 → 경로 입력 → Esc, 상위 메뉴는 바로 위 부모가 먼저", () => {
    render(<Harness id="right" />);
    fireEvent.click(screen.getByText("proj"));
    const input = screen.getByRole("textbox", { name: "경로로 이동" });
    expect((input as HTMLInputElement).value).toBe("/work/proj");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "경로로 이동" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "상위 폴더" }));
    // ContextMenu 에 ARIA 역할이 없어(보류 항목) 화면 텍스트로 순서를 확인한다.
    const labels = useContextMenu
      .getState()
      .items.map((m) => ("label" in m ? m.label : "-"));
    expect(labels).toEqual(["경로 복사", "-", "work", "/"]);
    expect(screen.getByText("work")).toBeTruthy();
  });

  it("⑤ 패턴 선택 바: Tab 으로 적용 버튼까지 가서 실행한다", async () => {
    render(<Harness id="right" />);
    act(() => useUI.getState().requestSelectPattern("right", "add"));
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const input = screen.getByRole("textbox", { name: "선택" });
    fireEvent.change(input, { target: { value: "*.md" } });
    const apply = screen.getByRole("button", { name: "적용" });
    fireEvent.blur(input, { relatedTarget: apply });
    fireEvent.click(apply);
    expect([...tab().selected]).toEqual(["readme.md"]);
  });

  it("⑥ 동기화 브라우징을 켜면 툴바 버튼이 눌린 상태로 남는다", () => {
    render(<Harness id="right" />);
    const sync = screen.getByRole("button", { name: "동기화 브라우징" });
    fireEvent.click(sync);
    expect(useUI.getState().syncBrowse).toBe(true);
    expect(sync.getAttribute("aria-pressed")).toBe("true");
    expect(sync.className).toMatch(/toolbar-sync-on/);
  });
});
