import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useKeyboardNav } from "./useKeyboardNav";
import { useClipboard } from "@/stores/clipboard";
import { usePanes, activeTab } from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import type { EntryRef } from "@/types/bindings";

function Harness() {
  useKeyboardNav(
    () => {},
    () => {},
    () => {},
  );
  return null;
}

const noop = () => {};
const ref = (name: string): EntryRef => ({
  location: activeTab(usePanes.getState(), "left").location,
  name,
});
const esc = () => fireEvent.keyDown(window, { key: "Escape" });

describe("Esc — 잘라내기 취소 / 선택 해제", () => {
  beforeEach(() => {
    useClipboard.getState().clear();
    useUIDialogs.getState().close();
    usePanes.getState().setSelected("left", []);
    usePanes.getState().setActivePane("left");
  });

  /**
   * 회귀 방지 — Ctrl+X 로 흐려진 항목을 Esc 로 취소해도 계속 흐린 채였다.
   * (전역 Esc 핸들러가 아예 없었다: DESIGN.md 는 "선택 해제 Esc" 라고 적어놨는데 미구현.)
   */
  it("잘라내기 대기 중이면 클립보드를 비운다", () => {
    useClipboard.getState().set([ref("a.txt")], "move");
    render(<Harness />);
    esc();
    expect(useClipboard.getState().entry).toBeNull();
  });

  /** 복사(Ctrl+C)는 원본이 그대로라 흐리게 표시하지 않는다 — Esc 로 지울 것도 없다. */
  it("복사 클립보드는 Esc 로 건드리지 않는다", () => {
    useClipboard.getState().set([ref("a.txt")], "copy");
    render(<Harness />);
    esc();
    expect(useClipboard.getState().entry?.mode).toBe("copy");
  });

  it("잘라내기가 없으면 선택을 해제한다", () => {
    usePanes.getState().setSelected("left", ["a.txt", "b.txt"]);
    render(<Harness />);
    esc();
    expect(activeTab(usePanes.getState(), "left").selected.size).toBe(0);
  });

  /** 잘라내기 취소가 먼저 — 한 번의 Esc 로 둘 다 날리면 되돌릴 수 없다. */
  it("잘라내기와 선택이 둘 다 있으면 잘라내기부터 취소", () => {
    useClipboard.getState().set([ref("a.txt")], "move");
    usePanes.getState().setSelected("left", ["a.txt"]);
    render(<Harness />);
    esc();
    expect(useClipboard.getState().entry).toBeNull();
    expect(activeTab(usePanes.getState(), "left").selected.size).toBe(1);
  });

  /** 다이얼로그가 열려 있으면 Esc 의 주인은 그쪽 — 뒤 목록을 건드리면 안 된다. */
  it("다이얼로그가 열려 있으면 아무것도 하지 않는다", () => {
    useClipboard.getState().set([ref("a.txt")], "move");
    useUIDialogs.getState().open({ kind: "settings" });
    render(<Harness />);
    esc();
    expect(useClipboard.getState().entry?.mode).toBe("move");
    useUIDialogs.getState().close();
  });

  /** 입력창 안에서는 그 입력이 Esc 를 쓴다 (필터 지우기 등). */
  it("입력창 포커스 중에는 무시", () => {
    useClipboard.getState().set([ref("a.txt")], "move");
    const { container } = render(
      <>
        <Harness />
        <input aria-label="q" />
      </>,
    );
    const input = container.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useClipboard.getState().entry?.mode).toBe("move");
    noop();
  });
});
