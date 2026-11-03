/**
 * file-view 사용자 시나리오 스모크 — 실제 Pane(목록) + PreviewPane + ContextMenu 트리를
 * 렌더하고 키보드·마우스로 처음부터 끝까지 따라간다. Tauri IPC 는 전부 모킹.
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { Entry, Location } from "@/types/bindings";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
const fsReadPreview = vi.fn();
const fsRename = vi.fn();
const listDirectory = vi.fn();
const fsCopyPlan = vi.fn();
vi.mock("@/types/bindings", () => ({
  commands: new Proxy(
    {
      fsReadPreview: (...a: unknown[]) => fsReadPreview(...a),
      fsRename: (...a: unknown[]) => fsRename(...a),
      listDirectory: (...a: unknown[]) => listDirectory(...a),
      fsCopyPlan: (...a: unknown[]) => fsCopyPlan(...a),
    } as Record<string, unknown>,
    {
      get: (t, k: string) =>
        t[k] ?? (() => Promise.resolve({ status: "ok", data: null })),
    },
  ),
}));

const { Pane } = await import("../Pane");
const { PreviewPane } = await import("../PreviewPane");
const { ContextMenu } = await import("@/components/ContextMenu");
const { usePanes, activeTab, computeDisplayed } =
  await import("@/stores/panes");
const { useUI } = await import("@/stores/ui");
const { useContextMenu } = await import("@/stores/contextMenu");
const { useKeyboardNav } = await import("@/hooks/useKeyboardNav");
const { buildEntryMenu, buildEmptyMenu } = await import("@/lib/entryMenu");
const { resetAnchors } = await import("@/lib/selectionAnchor");
const { clearHover } = await import("@/stores/previewHover");
const { useClipboard } = await import("@/stores/clipboard");
const i18n = (await import("@/i18n")).default;

const DIR: Location = { source: { kind: "local" }, path: "/smoke" };
const file = (name: string, size = 1): Entry => ({
  name,
  kind: "file",
  size,
  modified_ms: 0,
  permissions: null,
  hidden: false,
});
const NAMES = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];

// jsdom 은 레이아웃이 없다 — 가상 스크롤이 행을 그리도록 크기를 준다.
beforeAll(() => {
  const size = (w: number, h: number) => ({
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-drop-pane") ? h : w;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", size(400, 400));
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", size(600, 600));
  Object.defineProperty(HTMLElement.prototype, "clientHeight", size(400, 400));
  Object.defineProperty(HTMLElement.prototype, "clientWidth", size(600, 600));
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      bottom: 400,
      right: 600,
      width: 600,
      height: 400,
      toJSON: () => ({}),
    } as DOMRect;
  };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const noop = () => {};
function Harness({ withPreview = false }: { withPreview?: boolean }) {
  useKeyboardNav(noop, noop, () => useUI.getState().toggleQuickLook());
  const props = {
    onNavigate: noop,
    onActivate: noop,
    onRefresh: noop,
    onBack: noop,
    onForward: noop,
    onUp: noop,
    onUpdateArchive: noop,
    onReconnect: noop,
    // App 과 같은 순서: 활성 패널·커서·선택을 맞춘 뒤 메뉴.
    onEntryContextMenu: (
      id: "left" | "right",
      entry: Entry,
      index: number,
      e: React.MouseEvent,
    ) => {
      e.preventDefault();
      const s = usePanes.getState();
      s.setActivePane(id);
      s.setCursor(id, index);
      const t = activeTab(s, id);
      if (!t.selected.has(entry.name)) s.setSelected(id, [entry.name]);
      useContextMenu.getState().openAt(
        e.clientX,
        e.clientY,
        buildEntryMenu({
          paneId: id,
          entry,
          location: t.location,
          selectedCount: Math.max(
            1,
            activeTab(usePanes.getState(), id).selected.size,
          ),
          onActivate: noop,
          onOpenInOtherPane: noop,
        }),
      );
    },
    onEmptyContextMenu: (id: "left" | "right", e: React.MouseEvent) => {
      e.preventDefault();
      useContextMenu.getState().openAt(
        e.clientX,
        e.clientY,
        buildEmptyMenu({
          paneId: id,
          location: activeTab(usePanes.getState(), id).location,
          onRefresh: noop,
        }),
      );
    },
  };
  return (
    <>
      <Pane id="left" {...props} />
      <Pane id="right" {...props} />
      {withPreview && <PreviewPane />}
      <ContextMenu />
    </>
  );
}

const tab = (id: "left" | "right" = "left") =>
  activeTab(usePanes.getState(), id);
const cursorName = () => computeDisplayed(tab())[tab().cursorIndex]?.name;
const selected = () => [...tab().selected].sort();
const leftList = () =>
  document.querySelector('[data-drop-pane="left"]') as HTMLElement;
const row = (name: string, pane: "left" | "right" = "left") =>
  document
    .querySelector(`[data-drop-pane="${pane}"]`)!
    .querySelector(`[data-entry="${name}"]`) as HTMLElement;
const rowInner = (name: string, pane: "left" | "right" = "left") =>
  row(name, pane).firstElementChild as HTMLElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.clearAllMocks();
  resetAnchors();
  clearHover();
  useClipboard.getState().clear();
  fsCopyPlan.mockResolvedValue({
    status: "error",
    error: { kind: "Io", message: "stop" },
  });
  fsReadPreview.mockResolvedValue({
    status: "ok",
    data: { kind: "text", text: "hello", truncated: false, total_size: 5 },
  });
  for (const id of ["left", "right"] as const) {
    const p = usePanes.getState();
    p.closeAllTabs(id);
    p.setViewMode(id, "details");
    p.setEntries(
      id,
      DIR,
      NAMES.map((n) => file(n)),
      { pushHistory: false },
    );
    if (tab(id).sortKey !== "name") p.toggleSortKey(id, "name");
    if (tab(id).sortOrder !== "asc") p.toggleSortKey(id, "name");
    if (tab(id).filter) p.setFilter(id, "");
    // "/smoke" 에는 ".." 행이 맨 위에 있다 — 커서는 첫 파일에서 시작.
    p.setCursor(
      id,
      computeDisplayed(tab(id)).findIndex((e) => e.name === "a.txt"),
    );
    p.clearSelection(id);
  }
  usePanes.getState().setActivePane("left");
  useUI.setState({ previewOpen: true, renameTarget: null });
});
afterEach(() => {
  cleanup();
  useContextMenu.getState().close();
});

it("목록이 실제로 행을 그린다 (스모크 전제)", () => {
  render(<Harness />);
  expect(row("a.txt")).toBeTruthy();
  expect(row("e.txt")).toBeTruthy();
});

it("클릭 → Shift-클릭 → Shift-클릭: 기준점은 처음 클릭 항목에 남는다", () => {
  render(<Harness />);
  fireEvent.click(rowInner("b.txt"));
  fireEvent.click(rowInner("e.txt"), { shiftKey: true });
  fireEvent.click(rowInner("c.txt"), { shiftKey: true });
  expect(selected()).toEqual(["b.txt", "c.txt"]);
  // 이어서 일반 클릭 뒤 Shift+↓ 는 새 위치부터
  fireEvent.click(rowInner("d.txt"));
  fireEvent.keyDown(window, { key: "ArrowDown", shiftKey: true });
  expect(selected()).toEqual(["d.txt", "e.txt"]);
});

it("비활성 패널 커서 바는 회색, 활성 패널은 accent", () => {
  render(<Harness />);
  expect(rowInner("a.txt", "left").className).toContain("border-l-accent");
  expect(rowInner("a.txt", "right").className).toContain(
    "border-l-fg-muted/50",
  );
  fireEvent.keyDown(window, { key: "Tab" });
  expect(rowInner("a.txt", "right").className).toContain("border-l-accent");
});

it("정렬 머리글을 다시 눌러 역순이 돼도 커서는 보던 파일에 남는다", () => {
  render(<Harness />);
  fireEvent.click(rowInner("b.txt"));
  const nameHeader = within(
    leftList().parentElement as HTMLElement,
  ).getAllByRole("button", { name: /Name/ })[0]!;
  fireEvent.click(nameHeader);
  expect(tab().sortOrder).toBe("desc");
  expect(cursorName()).toBe("b.txt");
  expect(nameHeader.getAttribute("aria-sort")).toBe("descending");
});

it("마우스를 목록 위에 둔 채 ↓ 하면 미리보기가 커서를 따라간다", async () => {
  vi.useFakeTimers();
  render(<Harness withPreview />);
  // 포인터가 c.txt 위에 올라감 → 호버 미리보기
  fireEvent.mouseEnter(row("c.txt"), { clientX: 50, clientY: 70 });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(fsReadPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: "/smoke/c.txt" }),
  );
  // 키보드로 커서 이동 — 포인터는 그대로라 스크롤로 지나간 행은 호버가 아니다
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.mouseEnter(row("d.txt"), { clientX: 50, clientY: 70 });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(cursorName()).toBe("b.txt");
  expect(fsReadPreview).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: "/smoke/b.txt" }),
  );
  vi.useRealTimers();
});

it("같은 파일이 바뀌어 새로고침되면 미리보기를 다시 읽는다", async () => {
  vi.useFakeTimers();
  render(<Harness withPreview />);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  const before = fsReadPreview.mock.calls.length;
  act(() =>
    usePanes.getState().setEntries(
      "left",
      DIR,
      NAMES.map((n) => file(n, n === "a.txt" ? 99 : 1)),
      { pushHistory: false },
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(fsReadPreview.mock.calls.length).toBe(before + 1);
  vi.useRealTimers();
});

it("미리보기 IPC 가 reject 해도 로딩에 갇히지 않고 오류를 보인다", async () => {
  vi.useFakeTimers();
  fsReadPreview.mockRejectedValue(new Error("channel closed"));
  render(<Harness withPreview />);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(screen.getByText(/channel closed/)).toBeTruthy();
  vi.useRealTimers();
});

it("F2 이름 바꾸기: 한글 조합 Enter 는 무시, 확정 Enter 후 커서가 새 이름에", async () => {
  fsRename.mockResolvedValue({ status: "ok", data: null });
  render(<Harness />);
  fireEvent.click(rowInner("b.txt"));
  act(() => useUI.getState().requestInlineRename("left", "b.txt"));
  const input = within(row("b.txt")).getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "zz.txt" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(fsRename).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(fsRename).toHaveBeenCalledTimes(1);
  expect(cursorName()).toBe("zz.txt");
});

it("스크롤바를 누르면 마키가 시작되지 않아 선택이 유지된다", () => {
  render(<Harness />);
  fireEvent.click(rowInner("a.txt"));
  fireEvent.click(rowInner("b.txt"), { shiftKey: true });
  fireEvent.mouseDown(leftList(), { button: 0, clientX: 605, clientY: 50 });
  fireEvent.mouseUp(window);
  expect(selected()).toEqual(["a.txt", "b.txt"]);
  // 내용 영역 빈 곳 클릭은 기존대로 선택 해제
  fireEvent.mouseDown(leftList(), { button: 0, clientX: 300, clientY: 380 });
  fireEvent.mouseUp(window);
  expect(selected()).toEqual([]);
});

it("빈 영역 우클릭 메뉴는 현재 보기·정렬을 표시하고, 키보드로 하위 메뉴를 한 단계씩 닫는다", () => {
  render(<Harness />);
  fireEvent.contextMenu(leftList(), { clientX: 300, clientY: 380 });
  const menu = screen.getByRole("menu");
  expect(document.activeElement).toBe(menu);
  fireEvent.click(within(menu).getByText("Sort by"));
  const asc = screen.getByLabelText("Ascending");
  expect(asc.closest("button")?.textContent).toContain("Name");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByLabelText("Ascending")).toBeNull();
  expect(useContextMenu.getState().open).toBe(true);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(useContextMenu.getState().open).toBe(false);
});

it("파일 우클릭 메뉴: 열기·Quick Look → 클립보드 → 이름 변경·삭제 순서", () => {
  render(<Harness />);
  fireEvent.contextMenu(rowInner("c.txt"), { clientX: 40, clientY: 80 });
  const labels = within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .map((b) => b.textContent ?? "");
  const idx = (re: RegExp) => labels.findIndex((l) => re.test(l));
  expect(idx(/^Open/)).toBe(0);
  expect(idx(/Quick Look/)).toBe(1);
  expect(idx(/^Copy/)).toBeLessThan(idx(/^Rename/));
  expect(idx(/^Delete/)).toBe(idx(/^Rename/) + 1);
  expect(cursorName()).toBe("c.txt");
});

it("Space 를 다른 커맨드에 매면 Quick Look 이 열리지 않는다", async () => {
  const { useKeymap } = await import("@/stores/keymap");
  render(<Harness />);
  fireEvent.keyDown(window, { key: " " });
  expect(useUI.getState().quickLookOpen).toBe(true);
  act(() => useUI.getState().closeQuickLook());
  act(() =>
    useKeymap.setState({
      bindings: [{ key: "Space", command_id: "view.refresh" }],
    }),
  );
  fireEvent.keyDown(window, { key: " " });
  expect(useUI.getState().quickLookOpen).toBe(false);
  act(() => useKeymap.setState({ bindings: [] }));
});

it.each(["grid", "tiles"] as const)(
  "%s 보기에서도 항목을 가리키면 미리보기가 바뀐다",
  async (mode) => {
    vi.useFakeTimers();
    act(() => usePanes.getState().setViewMode("left", mode));
    render(<Harness withPreview />);
    fireEvent.mouseEnter(row("d.txt"), { clientX: 30, clientY: 30 });
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(fsReadPreview).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/smoke/d.txt" }),
    );
    vi.useRealTimers();
  },
);

it("폴더 항목 수를 못 읽으면 '세는 중' 대신 확인 불가를 보인다", async () => {
  vi.useFakeTimers();
  listDirectory.mockResolvedValue({
    status: "error",
    error: { kind: "Io", message: "denied" },
  });
  const dir: Entry = { ...file("box"), kind: "dir", size: null };
  act(() => {
    usePanes
      .getState()
      .setEntries("left", DIR, [dir, ...NAMES.map((n) => file(n))], {
        pushHistory: false,
      });
    usePanes.getState().setCursor(
      "left",
      computeDisplayed(tab()).findIndex((e) => e.name === "box"),
    );
  });
  render(<Harness withPreview />);
  await act(async () => vi.advanceTimersByTimeAsync(400));
  expect(screen.getByText("Unavailable")).toBeTruthy();
  vi.useRealTimers();
});

it("폴더 우클릭 '폴더에 붙여넣기'는 그 폴더 안으로 계획한다", async () => {
  const dir: Entry = { ...file("box"), kind: "dir", size: null };
  act(() =>
    usePanes
      .getState()
      .setEntries("left", DIR, [dir, ...NAMES.map((n) => file(n))], {
        pushHistory: false,
      }),
  );
  useClipboard.getState().set(
    [
      {
        location: { source: { kind: "local" }, path: "/elsewhere" },
        name: "x.txt",
      },
    ],
    "copy",
  );
  render(<Harness />);
  fireEvent.contextMenu(rowInner("box"), { clientX: 40, clientY: 40 });
  await act(async () =>
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Paste into folder/ }),
    ),
  );
  expect(fsCopyPlan).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({ path: "/smoke/box" }),
  );
});

it("↓ 로 다음 파일을 불러오는 동안 이전 미리보기를 흐리게 남겨 둔다", async () => {
  vi.useFakeTimers();
  render(<Harness withPreview />);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(screen.getByText("hello")).toBeTruthy();
  let release!: (v: unknown) => void;
  fsReadPreview.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  fireEvent.keyDown(window, { key: "ArrowDown" });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  // 새 응답 전: 이전 본문이 비지 않고 남아 있다(흐리게).
  expect(screen.getByText("hello").closest("[aria-busy]")).toBeTruthy();
  await act(async () =>
    release({
      status: "ok",
      data: { kind: "text", text: "world", truncated: false, total_size: 5 },
    }),
  );
  expect(screen.getByText("world")).toBeTruthy();
  vi.useRealTimers();
});

it("늦게 끝난 이름 바꾸기는 그 사이 다른 탭에서 시작한 편집을 건드리지 않는다", async () => {
  let finishA!: (v: unknown) => void;
  fsRename.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finishA = r;
      }),
  );
  render(<Harness />);
  // A 탭: a.txt → zz.txt, 응답 대기
  act(() => useUI.getState().requestInlineRename("left", "a.txt", tab().id));
  const inputA = within(row("a.txt")).getByRole("textbox");
  fireEvent.change(inputA, { target: { value: "zz.txt" } });
  fireEvent.keyDown(inputA, { key: "Enter" });
  // 같은 폴더의 B 탭으로 가서 b.txt 편집 시작
  act(() => {
    const p = usePanes.getState();
    p.openTab("left");
    p.setEntries(
      "left",
      DIR,
      NAMES.map((n) => file(n)),
      {
        pushHistory: false,
      },
    );
    p.setCursor(
      "left",
      computeDisplayed(tab()).findIndex((e) => e.name === "b.txt"),
    );
    useUI.getState().requestInlineRename("left", "b.txt", tab().id);
  });
  const sessionB = useUI.getState().renameTarget;
  await act(async () => finishA({ status: "ok", data: null }));
  expect(cursorName()).toBe("b.txt");
  expect(useUI.getState().renameTarget).toBe(sessionB);
  expect(within(row("b.txt")).getByRole("textbox")).toBeTruthy();
});

it("불러오는 동안 남겨 둔 이전 미리보기는 다시 마운트되지 않고 조작할 수 없다", async () => {
  vi.useFakeTimers();
  fsReadPreview.mockResolvedValue({
    status: "ok",
    data: { kind: "binary", total_size: 10 },
  });
  render(<Harness withPreview />);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  const btn = screen.getByRole("button", { name: /Open in default app/ });
  fsReadPreview.mockImplementation(() => new Promise(() => {}));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  await act(async () => vi.advanceTimersByTimeAsync(200));
  // 같은 엘리먼트(재마운트 없음) + inert 컨테이너 안(포인터·키보드 차단)
  const still = screen.getByRole("button", {
    name: /Open in default app/,
    hidden: true,
  });
  expect(still).toBe(btn);
  expect(still.closest("[inert]")).toBeTruthy();
  vi.useRealTimers();
});
