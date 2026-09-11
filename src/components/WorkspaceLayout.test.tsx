import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { useUI } from "@/stores/ui";
import { useSidebarWidth } from "@/stores/sidebarWidth";
import { usePreviewWidth } from "@/stores/previewWidth";

vi.mock("@/components/pane/PreviewPane", () => ({
  PreviewPane: () => <input aria-label="preview state" defaultValue="" />,
}));
let resize: ResizeObserverCallback;
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  useUI.setState({ sidebarOpen: true, previewOpen: true, singlePane: false });
  useSidebarWidth.setState({ width: 420 });
  usePreviewWidth.setState({ width: 260 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function resizeTo(width: number) {
  act(() =>
    resize(
      [{ contentRect: { width } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
}
it("좁은 창에서는 미리보기를 아래로 옮기고 넓히면 저장 폭과 편집 상태를 유지한다", () => {
  const { container } = render(
    <WorkspaceLayout sidebar={<div>sidebar</div>}>
      <input aria-label="pane state" />
    </WorkspaceLayout>,
  );
  resizeTo(788);
  expect(
    container
      .querySelector("[data-preview-placement]")
      ?.getAttribute("data-preview-placement"),
  ).toBe("below");
  expect(screen.getByText("sidebar").parentElement?.style.width).toBe("182px");
  fireEvent.change(screen.getByLabelText("pane state"), {
    target: { value: "unsaved name" },
  });
  fireEvent.change(screen.getByLabelText("preview state"), {
    target: { value: "keep preview" },
  });
  resizeTo(1500);
  expect(
    container
      .querySelector("[data-preview-placement]")
      ?.getAttribute("data-preview-placement"),
  ).toBe("side");
  expect(screen.getByText("sidebar").parentElement?.style.width).toBe("420px");
  expect((screen.getByLabelText("pane state") as HTMLInputElement).value).toBe(
    "unsaved name",
  );
  expect(
    (screen.getByLabelText("preview state") as HTMLInputElement).value,
  ).toBe("keep preview");
  expect(useSidebarWidth.getState().width).toBe(420);
  expect(usePreviewWidth.getState().width).toBe(260);
});
it("단일 패널과 사이드바 토글의 여유 공간을 반영한다", () => {
  const { container } = render(
    <WorkspaceLayout sidebar={<div>sidebar</div>}>
      <div>files</div>
    </WorkspaceLayout>,
  );
  resizeTo(788);
  act(() => useUI.setState({ singlePane: true, sidebarOpen: false }));
  expect(screen.queryByText("sidebar")).toBeNull();
  expect(
    container
      .querySelector("[data-preview-placement]")
      ?.getAttribute("data-preview-placement"),
  ).toBe("side");
});
