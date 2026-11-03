import { afterEach, beforeEach, expect, it } from "vitest";
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
