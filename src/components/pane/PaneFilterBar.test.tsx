import { afterEach, beforeEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { PaneFilterBar } from "./PaneFilterBar";
import { usePanes, activeTab } from "@/stores/panes";
import i18n from "@/i18n";

beforeEach(async () => {
  await i18n.changeLanguage("en");
  usePanes.getState().setFilter("left", "");
  usePanes.getState().setFilterFocused("left", false);
});
afterEach(cleanup);

it("Enter 는 필터를 유지한 채 입력 포커스를 놓아 목록 키 조작으로 돌아간다", () => {
  render(<PaneFilterBar id="left" />);
  act(() => usePanes.getState().setFilterFocused("left", true));
  const input = screen.getByRole("textbox", { name: "Name filter" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "log" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(activeTab(usePanes.getState(), "left").filter).toBe("log");
  expect(document.activeElement).not.toBe(input);
  expect(screen.getByRole("textbox", { name: "Name filter" })).toBeTruthy();
});

it("지우기 버튼은 필터를 비우고 바를 닫는다", () => {
  render(<PaneFilterBar id="left" />);
  act(() => usePanes.getState().setFilter("left", "log"));
  fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
  expect(activeTab(usePanes.getState(), "left").filter).toBe("");
  expect(screen.queryByRole("textbox")).toBeNull();
});
