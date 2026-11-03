import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PathBar } from "./PathBar";
import { useContextMenu, isSeparator } from "@/stores/contextMenu";
import i18n from "@/i18n";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

const writeText = vi.fn(() => Promise.resolve());
beforeEach(async () => {
  await i18n.changeLanguage("en");
  writeText.mockClear();
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  useContextMenu.getState().close();
  vi.unstubAllGlobals();
});

function renderBar(onSegmentClick = vi.fn()) {
  render(
    <PathBar
      location={{ source: { kind: "local" }, path: "/home/u/docs" }}
      canBack={false}
      canForward={false}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onUp={vi.fn()}
      onRefresh={vi.fn()}
      onSegmentClick={onSegmentClick}
    />,
  );
  return onSegmentClick;
}

it("현재 폴더 이름을 클릭하면 경로 입력으로 바뀌고 Esc 로 돌아온다", () => {
  const go = renderBar();
  fireEvent.click(screen.getByText("docs"));
  const input = screen.getByRole("textbox", { name: "Go to path" });
  expect((input as HTMLInputElement).value).toBe("/home/u/docs");
  expect(go).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("docs")).toBeTruthy();
});

it("상위 폴더 메뉴는 경로 복사 다음에 가까운 부모부터 나열한다", () => {
  const go = renderBar();
  fireEvent.click(screen.getByRole("button", { name: "Parent folders" }));
  const items = useContextMenu.getState().items;
  expect(items.map((m) => (isSeparator(m) ? "-" : m.label))).toEqual([
    "Copy path",
    "-",
    "u",
    "home",
    "/",
  ]);
  const parent = items[2]!;
  if (!isSeparator(parent)) parent.onSelect?.();
  expect(go).toHaveBeenCalledWith("/home/u");
});

it("현재 폴더 우클릭 메뉴에서 경로를 복사한다", () => {
  renderBar();
  fireEvent.contextMenu(screen.getByText("docs"));
  const copy = useContextMenu.getState().items[0]!;
  expect(isSeparator(copy) ? "" : copy.label).toBe("Copy path");
  if (!isSeparator(copy)) copy.onSelect?.();
  expect(writeText).toHaveBeenCalledWith("/home/u/docs");
});

it("위로·새로고침도 툴팁이 있고, 휴지통에서는 경로 편집 버튼을 숨긴다", () => {
  render(
    <PathBar
      location={{ source: { kind: "local" }, path: "/home/u" }}
      trash
      canBack={false}
      canForward={false}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onUp={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Up" }).title).toMatch(/parent/);
  expect(screen.getByRole("button", { name: "Refresh" }).title).toMatch(
    /^Refresh/,
  );
  expect(screen.queryByRole("button", { name: "Edit path" })).toBeNull();
});
