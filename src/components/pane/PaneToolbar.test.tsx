import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PaneToolbar } from "./PaneToolbar";
import { ContextMenu } from "@/components/ContextMenu";
import { usePanes, activeTab } from "@/stores/panes";
import { useContextMenu } from "@/stores/contextMenu";
import { triggerMkdir, triggerDelete } from "@/lib/fileActions";
import i18n from "@/i18n";

vi.mock("@/lib/fileActions", () => ({
  triggerMkdir: vi.fn(),
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
