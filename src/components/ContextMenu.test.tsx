import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
} from "@testing-library/react";
import { ContextMenu } from "./ContextMenu";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import "@/i18n";

describe("ContextMenu", () => {
  beforeEach(() => {
    cleanup();
    useContextMenu.setState({ open: false, x: 0, y: 0, items: [] });
  });

  it("renders nothing when closed", () => {
    render(<ContextMenu />);
    expect(screen.queryByText("Rename")).toBeNull();
  });

  it("renders items and runs onSelect via keyboard Enter, then closes", () => {
    const onSelect = vi.fn();
    render(<ContextMenu />);
    act(() =>
      useContextMenu.getState().openAt(10, 10, [
        { id: "rename", label: "Rename", onSelect },
        { id: "delete", label: "Delete", onSelect: vi.fn() },
      ]),
    );
    expect(screen.getByText("Rename")).toBeTruthy();

    // 열리면 cursor 는 첫 항목(Rename) — Enter 로 즉시 실행
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("closes on Escape without selecting", () => {
    const onSelect = vi.fn();
    render(<ContextMenu />);
    act(() =>
      useContextMenu
        .getState()
        .openAt(10, 10, [{ id: "x", label: "X", onSelect }]),
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("runs onSelect on click", () => {
    const onSelect = vi.fn();
    render(<ContextMenu />);
    act(() =>
      useContextMenu
        .getState()
        .openAt(10, 10, [{ id: "x", label: "Click me", onSelect }]),
    );
    fireEvent.click(screen.getByText("Click me"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("opens a submenu (ArrowRight) and runs a child onSelect", () => {
    const childSel = vi.fn();
    render(<ContextMenu />);
    act(() =>
      useContextMenu.getState().openAt(10, 10, [
        {
          id: "more",
          label: "More",
          children: [{ id: "c1", label: "Child 1", onSelect: childSel }],
        },
      ]),
    );
    // 자식은 펼치기 전엔 없음
    expect(screen.queryByText("Child 1")).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Child 1")).toBeTruthy();
    fireEvent.click(screen.getByText("Child 1"));
    expect(childSel).toHaveBeenCalledTimes(1);
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("lazily loads submenu children only when opened", async () => {
    const load = vi
      .fn()
      .mockResolvedValue([{ id: "l1", label: "Lazy 1", onSelect: vi.fn() }]);
    render(<ContextMenu />);
    act(() =>
      useContextMenu
        .getState()
        .openAt(10, 10, [{ id: "more", label: "More", loadChildren: load }]),
    );
    // 펼치기 전엔 호출 안 됨 (매번 읽지 않음)
    expect(load).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Lazy 1")).toBeTruthy();
  });

  it("drops a late lazy submenu reply from a menu that was closed and reopened", async () => {
    let resolveA!: (v: MenuEntry[]) => void;
    const loadA = vi.fn(
      () =>
        new Promise<MenuEntry[]>((r) => {
          resolveA = r;
        }),
    );
    const loadB = vi
      .fn()
      .mockResolvedValue([{ id: "b1", label: "B action", onSelect: vi.fn() }]);
    render(<ContextMenu />);
    act(() => {
      useContextMenu
        .getState()
        .openAt(10, 10, [{ id: "more", label: "More", loadChildren: loadA }]);
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    act(() => useContextMenu.getState().close());
    act(() => {
      useContextMenu
        .getState()
        .openAt(10, 10, [{ id: "more", label: "More", loadChildren: loadB }]);
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(await screen.findByText("B action")).toBeTruthy();
    await act(async () => {
      resolveA([{ id: "a1", label: "A action", onSelect: vi.fn() }]);
    });
    expect(screen.queryByText("A action")).toBeNull();
    expect(screen.getByText("B action")).toBeTruthy();
  });

  it("limits the root menu to the viewport and owns focus while open", () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    render(<ContextMenu />);
    act(() => {
      useContextMenu
        .getState()
        .openAt(10, 10, [{ id: "x", label: "X", onSelect: vi.fn() }]);
    });
    const menu = screen.getByRole("menu");
    expect(menu.style.overflowY).toBe("auto");
    expect(menu.style.maxHeight).toContain("100vh");
    expect(document.activeElement).toBe(menu);
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    act(() => useContextMenu.getState().close());
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("wraps with arrows, jumps with Home/End, and Esc closes one submenu level", () => {
    const a = vi.fn();
    const c = vi.fn();
    render(<ContextMenu />);
    act(() => {
      useContextMenu.getState().openAt(10, 10, [
        { id: "a", label: "A", onSelect: a },
        {
          id: "b",
          label: "B",
          children: [{ id: "b1", label: "B1", onSelect: vi.fn() }],
        },
        { id: "c", label: "C", onSelect: c },
      ]);
    });
    fireEvent.keyDown(window, { key: "ArrowUp" }); // A → C (순환)
    fireEvent.keyDown(window, { key: "Enter" });
    expect(c).toHaveBeenCalledTimes(1);

    act(() => {
      useContextMenu.getState().openAt(10, 10, [
        { id: "a", label: "A", onSelect: a },
        {
          id: "b",
          label: "B",
          children: [{ id: "b1", label: "B1", onSelect: vi.fn() }],
        },
      ]);
    });
    fireEvent.keyDown(window, { key: "End" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("B1")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("B1")).toBeNull();
    expect(useContextMenu.getState().open).toBe(true);
    fireEvent.keyDown(window, { key: "Home" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(a).toHaveBeenCalledTimes(1);
  });
});
