import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SelectPatternBar } from "./SelectPatternBar";
import { usePanes, activeTab } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useToast } from "@/stores/toast";
import type { Entry } from "@/types/bindings";
import i18n from "@/i18n";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useCommands } from "@/stores/commands";

const file = (name: string) =>
  ({
    name,
    kind: "file",
    size: 1,
    modified_ms: 0,
    permissions: null,
    hidden: false,
  }) as Entry;

beforeEach(async () => {
  await i18n.changeLanguage("ko");
  usePanes
    .getState()
    .setEntries("left", { source: { kind: "local" }, path: "/" }, [
      file("a.ts"),
      file("b.ts"),
      file("c.md"),
    ]);
  usePanes.getState().setSelected("left", []);
});
afterEach(cleanup);

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

async function openBar(mode: "add" | "remove" = "add") {
  // act 안에서는 렌더가 act 종료 시 반영되므로, 포커스용 다음 프레임은 그 뒤에 기다린다.
  act(() => useUI.getState().requestSelectPattern("left", mode));
  await act(frame);
}

it("키보드: 입력 → Tab 으로 적용 버튼 → 실행하면 선택하고 한국어로 알린다", async () => {
  render(<SelectPatternBar id="left" />);
  await openBar();
  const input = screen.getByRole("textbox", { name: "선택" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "*.ts" } });
  const apply = screen.getByRole("button", { name: "적용" });
  // Tab 이동: input blur 의 relatedTarget 이 바 안의 버튼 → 닫히지 않는다.
  fireEvent.blur(input, { relatedTarget: apply });
  apply.focus();
  expect(screen.getByRole("button", { name: "적용" })).toBe(apply);
  fireEvent.click(apply); // 키보드 Enter/Space 활성화는 click 으로 합성된다.
  expect([...activeTab(usePanes.getState(), "left").selected].sort()).toEqual([
    "a.ts",
    "b.ts",
  ]);
  expect(useToast.getState().toasts.at(-1)?.message).toBe("2개 선택");
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("모드 버튼으로 선택 해제로 바꿔 적용할 수 있고, 바 밖으로 포커스가 나가면 닫힌다", async () => {
  usePanes.getState().setSelected("left", ["a.ts", "b.ts", "c.md"]);
  render(<SelectPatternBar id="left" />);
  await openBar();
  fireEvent.click(screen.getByRole("button", { name: "선택" }));
  const input = screen.getByRole("textbox", { name: "선택 해제" });
  fireEvent.change(input, { target: { value: "*.md" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect([...activeTab(usePanes.getState(), "left").selected].sort()).toEqual([
    "a.ts",
    "b.ts",
  ]);
  await openBar();
  fireEvent.blur(screen.getByRole("textbox"), { relatedTarget: document.body });
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("WebKit 처럼 버튼 클릭이 포커스를 옮기지 않아도 마우스로 적용된다", async () => {
  render(<SelectPatternBar id="left" />);
  await openBar();
  const input = screen.getByRole("textbox", { name: "선택" });
  fireEvent.change(input, { target: { value: "*.md" } });
  const apply = screen.getByRole("button", { name: "적용" });
  // mousedown 기본 동작(포커스 이동)이 막혀야 blur 가 일어나지 않는다.
  expect(fireEvent.mouseDown(apply)).toBe(false);
  fireEvent.click(apply);
  expect([...activeTab(usePanes.getState(), "left").selected]).toEqual([
    "c.md",
  ]);
});

const onActivate = vi.fn();
const onQuickLook = vi.fn();
function WithNav() {
  useKeyboardNav(onActivate, vi.fn(), onQuickLook);
  return <SelectPatternBar id="left" />;
}

it("버튼에 포커스가 있을 때 Enter·Space·Tab 은 전역 목록 키로 새지 않고, Esc 는 바를 닫는다", async () => {
  onActivate.mockClear();
  onQuickLook.mockClear();
  usePanes.getState().setActivePane("left");
  usePanes.getState().setCursor("left", 0);
  render(<WithNav />);
  await openBar();
  const apply = screen.getByRole("button", { name: "적용" });
  apply.focus();
  // 기본 동작(버튼 클릭 합성·포커스 이동)을 막지 않아야 한다.
  expect(fireEvent.keyDown(apply, { key: "Enter" })).toBe(true);
  expect(fireEvent.keyDown(apply, { key: " " })).toBe(true);
  expect(fireEvent.keyDown(apply, { key: "Tab" })).toBe(true);
  expect(onActivate).not.toHaveBeenCalled();
  expect(onQuickLook).not.toHaveBeenCalled();
  expect(usePanes.getState().activePane).toBe("left");
  fireEvent.keyDown(apply, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("수식키 조합은 바 안에서도 전역 명령으로 간다 (Ctrl+→, Shift+Space), Shift+Tab 은 막는다", async () => {
  const openInOther = vi.fn();
  const calcSize = vi.fn();
  useCommands.getState().setBuiltins([
    {
      id: "pane.openInOther",
      label: "o",
      category: "Navigation",
      defaultKey: "Ctrl+Right",
      action: openInOther,
    },
    {
      id: "file.calcSize",
      label: "c",
      category: "File",
      defaultKey: "Shift+Space",
      action: calcSize,
    },
  ]);
  function WithShortcuts() {
    useGlobalShortcuts();
    useKeyboardNav(onActivate, vi.fn(), onQuickLook);
    return <SelectPatternBar id="left" />;
  }
  usePanes.getState().setActivePane("left");
  usePanes.getState().setSelected("left", []);
  render(<WithShortcuts />);
  await openBar();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "*.ts" } });
  const apply = screen.getByRole("button", { name: "적용" });
  apply.focus();
  fireEvent.keyDown(apply, { key: "ArrowRight", ctrlKey: true });
  expect(openInOther).toHaveBeenCalledOnce();
  // 전역 명령이 처리하며 기본 동작(버튼 클릭)을 막는다 → 패턴이 적용되지 않는다.
  expect(fireEvent.keyDown(apply, { key: " ", shiftKey: true })).toBe(false);
  expect(calcSize).toHaveBeenCalledOnce();
  expect(fireEvent.keyDown(apply, { key: "Tab", shiftKey: true })).toBe(true);
  expect(usePanes.getState().activePane).toBe("left");
  useCommands.getState().setBuiltins([]);
});
