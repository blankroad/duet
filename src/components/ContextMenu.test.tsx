import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { ContextMenu } from "./ContextMenu";
import { useContextMenu } from "@/stores/contextMenu";

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
    act(() => useContextMenu.getState().openAt(10, 10, [{ id: "x", label: "X", onSelect }]));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSelect).not.toHaveBeenCalled();
    expect(useContextMenu.getState().open).toBe(false);
  });

  it("runs onSelect on click", () => {
    const onSelect = vi.fn();
    render(<ContextMenu />);
    act(() =>
      useContextMenu.getState().openAt(10, 10, [{ id: "x", label: "Click me", onSelect }]),
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
});
