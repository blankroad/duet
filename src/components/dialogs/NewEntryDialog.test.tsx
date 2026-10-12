import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { NewEntryDialog } from "./NewEntryDialog";
import i18n from "@/i18n";
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
const parent = { source: { kind: "local" as const }, path: "/tmp/create" };
beforeEach(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
it("keeps the name and dialog after a failed creation and allows retry", async () => {
  const submit = vi
    .fn()
    .mockRejectedValueOnce({ kind: "Io", message: "already exists" })
    .mockResolvedValue(undefined);
  const close = vi.fn();
  render(
    <NewEntryDialog
      kind="file"
      parent={parent}
      onClose={close}
      onSubmit={submit}
    />,
  );
  const input = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "note.txt" } });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: /^Create↵$/ })),
  );
  expect(input.value).toBe("note.txt");
  expect(screen.getByRole("alert").textContent).toContain("already exists");
  expect(close).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: /^Create and edit/ })),
  );
  expect(submit).toHaveBeenLastCalledWith("note.txt", true);
});
it("prevents duplicate submission and dismissal while creating", async () => {
  let finish!: () => void;
  const submit = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const close = vi.fn();
  render(
    <NewEntryDialog
      kind="dir"
      parent={parent}
      onClose={close}
      onSubmit={submit}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "검증 폴더" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(submit).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  expect((input as HTMLInputElement).disabled).toBe(true);
  await act(async () => finish());
});
it("shows invalid names inline and does not submit during IME composition", () => {
  const submit = vi.fn();
  render(
    <NewEntryDialog
      kind="file"
      parent={parent}
      onClose={() => {}}
      onSubmit={submit}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "../outside" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByRole("alert")).toBeDefined();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "한글.txt" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(submit).not.toHaveBeenCalled();
});
