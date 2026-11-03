import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@/i18n";
import { useJournal } from "@/stores/journal";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";
import { triggerRedo, triggerUndo } from "@/lib/fileActions";
import { HistoryDialog } from "./HistoryDialog";

vi.mock("@/lib/fileActions", () => ({
  triggerUndo: vi.fn().mockResolvedValue(undefined),
  triggerRedo: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useKeymap.getState().setAll([]);
  useCommands.getState().setBuiltins([
    {
      id: "edit.undo",
      label: "Undo",
      category: "File",
      defaultKey: "Ctrl+Z",
      action: () => {},
    },
    {
      id: "edit.redo",
      label: "Redo",
      category: "File",
      defaultKey: "Ctrl+Shift+Z",
      action: () => {},
    },
  ]);
  useJournal.setState({ entries: [], hasUndoable: true, hasRedoable: false });
});
afterEach(cleanup);

describe("HistoryDialog", () => {
  it("창 안에서 안내된 되돌리기 키가 동작한다 (키맵을 따름)", () => {
    render(<HistoryDialog onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /Close/ });
    btn.focus();
    fireEvent.keyDown(btn, { key: "z", ctrlKey: true });
    expect(triggerUndo).toHaveBeenCalledTimes(1);
    // 다시 실행 불가 상태면 아무것도 안 한다.
    fireEvent.keyDown(btn, { key: "z", ctrlKey: true, shiftKey: true });
    expect(triggerRedo).not.toHaveBeenCalled();
  });

  it("되돌리기를 다른 키로 바꾸면 그 키로", () => {
    useKeymap.getState().setAll([{ key: "Alt+U", command_id: "edit.undo" }]);
    render(<HistoryDialog onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /Close/ });
    fireEvent.keyDown(btn, { key: "z", ctrlKey: true });
    expect(triggerUndo).not.toHaveBeenCalled();
    fireEvent.keyDown(btn, { key: "u", altKey: true, code: "KeyU" });
    expect(triggerUndo).toHaveBeenCalledTimes(1);
  });
});
