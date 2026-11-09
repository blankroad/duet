import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { AppLauncherStrip } from "@/components/AppLauncherStrip";
import { useAppLaunchers } from "@/stores/appLaunchers";
import { PromptDialogHost } from "@/components/dialogs/PromptDialog";
import { promptText, usePromptDialog } from "@/stores/promptDialog";

const cmd = vi.hoisted(() => ({ appsRename: vi.fn() }));
vi.mock("@/types/bindings", () => ({ commands: cmd }));

const folder = {
  id: "folder",
  name: "업무",
  path: null,
  args: [],
  children: [],
};

beforeEach(() => {
  cmd.appsRename
    .mockReset()
    .mockResolvedValue({ status: "ok", data: [folder] });
  useAppLaunchers.getState().setAll([folder]);
});

afterEach(() => {
  cleanup();
  usePromptDialog.getState().settle(null);
  useAppLaunchers.getState().setAll([]);
});

function editLauncherName() {
  render(<AppLauncherStrip />);
  fireEvent.click(screen.getByTitle("업무"));
  fireEvent.doubleClick(screen.getByText("업무"));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "업무 문" } });
  return input;
}

describe("shell-settings-05: 다른 이름 입력의 IME", () => {
  it("shell-settings-05: 런처 폴더 조합 Enter는 이름 저장을 실행하지 않는다", async () => {
    const input = editLauncherName();
    await act(async () => {
      fireEvent.keyDown(input, {
        key: "Enter",
        keyCode: 229,
        isComposing: true,
      });
    });
    expect(cmd.appsRename).not.toHaveBeenCalled();
  });

  it("shell-settings-05: 런처 폴더 조합 Escape는 이름 편집기를 닫지 않는다", () => {
    const input = editLauncherName();
    fireEvent.keyDown(input, {
      key: "Escape",
      keyCode: 229,
      isComposing: true,
    });
    expect(screen.queryByRole("textbox")).not.toBeNull();
  });

  it("런처 폴더 조합이 끝난 Enter는 이름을 저장한다", async () => {
    const input = editLauncherName();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
    });
    expect(cmd.appsRename).toHaveBeenCalledWith("folder", "업무 문");
  });

  it("shell-settings-05: 사이드바 공통 이름 프롬프트의 조합 Escape는 대화상자를 닫지 않는다", () => {
    render(<PromptDialogHost />);
    act(() => {
      void promptText({ title: "별명", initial: "업무 문" });
    });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Escape",
      keyCode: 229,
      isComposing: true,
    });
    expect(usePromptDialog.getState().req).not.toBeNull();
  });

  it("사이드바 공통 이름 프롬프트는 조합 Enter를 제출하지 않는다", () => {
    render(<PromptDialogHost />);
    act(() => {
      void promptText({ title: "별명", initial: "업무 문" });
    });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      keyCode: 229,
      isComposing: true,
    });
    expect(usePromptDialog.getState().req).not.toBeNull();
  });
});
