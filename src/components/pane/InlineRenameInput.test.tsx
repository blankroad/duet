import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { InlineRenameInput } from "./InlineRenameInput";
import { commands } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import i18n from "@/i18n";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({ commands: { fsRename: vi.fn() } }));

const target = {
  location: { source: { kind: "local" as const }, path: "/tmp/rn" },
  name: "report.final.txt",
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  useToast.setState({ toasts: [] });
});
afterEach(cleanup);

function setup() {
  const onDone = vi.fn();
  render(<InlineRenameInput target={target} isDir={false} onDone={onDone} />);
  return { onDone, input: screen.getByRole("textbox") as HTMLInputElement };
}

it("selects the name without the last extension on mount", () => {
  const { input } = setup();
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe("report.final".length);
});

it("does not commit on Enter while an IME composition is active", () => {
  const { input, onDone } = setup();
  fireEvent.change(input, { target: { value: "보고" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(commands.fsRename).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
});

it("renames once even if blur follows Enter before the reply arrives", async () => {
  let resolve!: (v: unknown) => void;
  vi.mocked(commands.fsRename).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }) as never,
  );
  const { input, onDone } = setup();
  fireEvent.change(input, { target: { value: "new.txt" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  expect(commands.fsRename).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ status: "ok", data: null }));
  expect(onDone).toHaveBeenCalledWith(true, "new.txt");
});

it("keeps the typed name for retry when Enter commit fails", async () => {
  vi.mocked(commands.fsRename).mockResolvedValue({
    status: "error",
    error: { kind: "Io", message: "denied" },
  } as never);
  const { input, onDone } = setup();
  fireEvent.change(input, { target: { value: "taken.txt" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(onDone).not.toHaveBeenCalled();
  expect(input.value).toBe("taken.txt");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(JSON.stringify(useToast.getState().toasts)).toContain("Rename failed");
});

it("rejects invalid names locally without calling the backend", async () => {
  const { input, onDone } = setup();
  fireEvent.change(input, { target: { value: "a/b" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(commands.fsRename).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
  expect(input.getAttribute("aria-invalid")).toBe("true");
});

it("cancels with Escape", () => {
  const { input, onDone } = setup();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onDone).toHaveBeenCalledWith(false, undefined);
});

it("unlocks the editor for retry when the rename IPC itself rejects", async () => {
  vi.mocked(commands.fsRename).mockRejectedValue(new Error("transport lost"));
  const { input, onDone } = setup();
  fireEvent.change(input, { target: { value: "new.txt" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(input.readOnly).toBe(false);
  expect(onDone).not.toHaveBeenCalled();
  expect(JSON.stringify(useToast.getState().toasts)).toContain(
    "transport lost",
  );
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onDone).toHaveBeenCalledWith(false, undefined);
});
