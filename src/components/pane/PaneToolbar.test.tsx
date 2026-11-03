import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { PaneToolbar } from "./PaneToolbar";
import { ContextMenu } from "@/components/ContextMenu";
import { usePanes, activeTab } from "@/stores/panes";
import { useContextMenu } from "@/stores/contextMenu";
import { triggerMkdir, triggerNewFile, triggerDelete } from "@/lib/fileActions";
import i18n from "@/i18n";

vi.mock("@/lib/fileActions", () => ({
  triggerMkdir: vi.fn(),
  triggerNewFile: vi.fn(),
  triggerCopy: vi.fn(),
  triggerMove: vi.fn(),
  triggerDelete: vi.fn(),
}));
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  usePanes.getState().setActivePane("left");
  usePanes.getState().setViewMode("left", "details");
  usePanes.getState().setViewMode("right", "details");
});
afterEach(() => {
  cleanup();
  useContextMenu.getState().close();
});
it("키보드 클릭도 해당 패널을 활성화한 뒤 파일 작업을 실행한다", () => {
  vi.mocked(triggerMkdir).mockImplementation(() => {
    expect(usePanes.getState().activePane).toBe("right");
  });
  render(<PaneToolbar id="right" />);
  // fireEvent.click은 mousedown을 합성하지 않는다: 패널 바깥의 키보드 포커스 경로.
  fireEvent.click(screen.getByRole("button", { name: /^New folder/ }));
  expect(triggerMkdir).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /^New file/ }));
  expect(triggerNewFile).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: /^Delete to trash/ }));
  expect(triggerDelete).toHaveBeenCalledWith(
    "trash",
    expect.any(Function),
    expect.any(Function),
  );
});
it("보기 메뉴의 키보드 선택은 해당 패널에만 적용한다", () => {
  render(
    <>
      <PaneToolbar id="right" />
      <ContextMenu />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  fireEvent.keyDown(window, { key: "ArrowDown" });
  fireEvent.keyDown(window, { key: "Enter" });
  expect(activeTab(usePanes.getState(), "right").viewMode).toBe("grid");
  expect(activeTab(usePanes.getState(), "left").viewMode).toBe("details");
  expect(useContextMenu.getState().open).toBe(false);
});
it("보기 메뉴를 취소하면 설정을 바꾸지 않는다", () => {
  render(
    <>
      <PaneToolbar id="right" />
      <ContextMenu />
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(useContextMenu.getState().open).toBe(false);
  expect(activeTab(usePanes.getState(), "right").viewMode).toBe("details");
});
it("숨김 파일 토글은 반응형 보기 묶음 밖에서 1클릭으로 바뀐다", () => {
  const { container } = render(<PaneToolbar id="right" />);
  const before = activeTab(usePanes.getState(), "right").showHidden;
  const btn = screen.getByRole("button", { name: "Hidden files" });
  // jsdom 은 컨테이너 쿼리를 적용하지 않으므로 구조로 확인: 좁은 폭에서 숨는 묶음 밖이어야 한다.
  expect(btn.closest(".toolbar-view-buttons")).toBeNull();
  expect(btn.className).not.toMatch(/toolbar-sync/);
  expect(container.contains(btn)).toBe(true);
  expect(btn.getAttribute("aria-pressed")).toBe(String(before));
  fireEvent.click(btn);
  expect(activeTab(usePanes.getState(), "right").showHidden).toBe(!before);
  expect(btn.getAttribute("aria-pressed")).toBe(String(!before));
  expect(usePanes.getState().activePane).toBe("right");
  expect(activeTab(usePanes.getState(), "left").showHidden).toBe(false);
});
it("필터 버튼은 해당 패널의 빠른 필터를 열고, 걸린 필터를 눌림으로 보인다", () => {
  render(<PaneToolbar id="right" />);
  const btn = screen.getByRole("button", { name: "Name filter" });
  expect(btn.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(btn);
  expect(usePanes.getState().activePane).toBe("right");
  expect(activeTab(usePanes.getState(), "right").filterFocused).toBe(true);
  expect(activeTab(usePanes.getState(), "left").filterFocused).toBe(false);
  act(() => usePanes.getState().setFilter("right", "log"));
  expect(btn.getAttribute("aria-pressed")).toBe("true");
  expect(btn.getAttribute("title")).toMatch(/log/);
  act(() => {
    usePanes.getState().setFilter("right", "");
    usePanes.getState().setFilterFocused("right", false);
  });
});
