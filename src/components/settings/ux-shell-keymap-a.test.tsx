import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { KeymapSection } from "./KeymapSection";
import { useCommands } from "@/stores/commands";
import { useKeymap } from "@/stores/keymap";
import i18n from "@/i18n";

const h = vi.hoisted(() => ({
  set: vi.fn(),
  unset: vi.fn(),
  reset: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({
  commands: { keymapSet: h.set, keymapUnset: h.unset, keymapReset: h.reset },
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: h.confirm }));

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
  useCommands.setState({
    builtins: [
      {
        id: "fixture.one",
        label: "Fixture One",
        category: "File",
        defaultKey: "F5",
        action: vi.fn(),
      },
      {
        id: "fixture.two",
        label: "Fixture Two",
        category: "File",
        defaultKey: "F6",
        action: vi.fn(),
      },
    ],
    dynamic: [],
  });
  useKeymap.setState({ bindings: [] });
  h.set.mockResolvedValue({
    status: "ok",
    data: [{ key: "F6", command_id: "fixture.one" }],
  });
  h.unset.mockResolvedValue({ status: "ok", data: [] });
  h.reset.mockResolvedValue({ status: "ok", data: [] });
});
afterEach(cleanup);

it("conflict can be cancelled, then explicitly replaced; reset restores defaults", async () => {
  render(<KeymapSection />);
  fireEvent.click(
    screen.getAllByRole("button", { name: i18n.t("settings.keymap.edit") })[0]!,
  );
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: i18n.t("settings.keymap.pressKey") }),
    { key: "F6" },
  );
  expect(screen.getByRole("alert").textContent).toContain("Fixture Two");
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("common.cancel") }),
  );
  expect(h.set).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getAllByRole("button", { name: i18n.t("settings.keymap.edit") })[0]!,
  );
  fireEvent.keyDown(
    screen.getByRole("textbox", { name: i18n.t("settings.keymap.pressKey") }),
    { key: "F6" },
  );
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("settings.keymap.conflictReplace"),
      }),
    );
  });
  expect(h.set).toHaveBeenCalledWith("F6", "fixture.one");
  expect(useKeymap.getState().bindings).toEqual([
    { key: "F6", command_id: "fixture.one" },
  ]);
  h.confirm.mockResolvedValue(false);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("settings.keymap.restoreDefaults"),
      }),
    );
  });
  expect(h.reset).not.toHaveBeenCalled();
  h.confirm.mockResolvedValue(true);
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("settings.keymap.restoreDefaults"),
      }),
    );
  });
  expect(h.reset).toHaveBeenCalledOnce();
  expect(useKeymap.getState().bindings).toEqual([]);
});

// L1 independent review: use the actual window dispatch hooks, not action() alone.
import { buildBuiltins, commandLabel, type BuiltinDeps } from "@/lib/commands";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { InlineRenameInput } from "@/components/pane/InlineRenameInput";
import { useContextMenu } from "@/stores/contextMenu";

function dispatchHarness(permanentDeleteEnabled = true) {
  const editFile = vi.fn();
  const rename = vi.fn();
  const trash = vi.fn();
  const deletePerm = vi.fn();
  const newFolder = vi.fn();
  const deps = new Proxy(
    {
      permanentDeleteEnabled,
      editFile,
      rename,
      delete: trash,
      deletePerm,
      newFolder,
    },
    {
      get: (t, k) => (k in t ? Reflect.get(t, k) : () => {}),
    },
  ) as unknown as BuiltinDeps;
  const builtins = buildBuiltins(deps);
  useCommands.setState({ builtins, dynamic: [] });
  useKeymap.setState({ bindings: [] });
  useContextMenu.setState({ open: false });
  const up = vi.fn();
  renderHook(() => {
    useKeyboardNav(vi.fn(), up, vi.fn());
    useGlobalShortcuts();
  });
  return { editFile, rename, trash, deletePerm, newFolder, builtins, up };
}

it("UX-SHL-07: F4 dispatches once through global shortcuts; palette labels are translated", async () => {
  const d = dispatchHarness();
  fireEvent.keyDown(window, { key: "F4" });
  expect(d.editFile).toHaveBeenCalledOnce();
  const edit = d.builtins.find((c) => c.id === "file.edit")!;
  expect(edit.allowInInput).not.toBe(true);
  for (const [locale, label] of [
    ["en", "Edit file"],
    ["ko", "파일 편집"],
  ]) {
    await i18n.changeLanguage(locale);
    expect(commandLabel(edit, i18n.t.bind(i18n))).toBe(label);
  }
});

it("L1: alternates dispatch once and permanent-delete alternate is gated", () => {
  const d = dispatchHarness();
  fireEvent.keyDown(window, { key: "F6", shiftKey: true });
  fireEvent.keyDown(window, { key: "F8" });
  fireEvent.keyDown(window, { key: "F8", shiftKey: true });
  fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
  expect(d.rename).toHaveBeenCalledOnce();
  expect(d.trash).toHaveBeenCalledOnce();
  expect(d.deletePerm).toHaveBeenCalledOnce();
  expect(d.newFolder).toHaveBeenCalledOnce();
  expect(
    buildBuiltins(
      new Proxy(
        { permanentDeleteEnabled: false },
        { get: (t, k) => (k in t ? Reflect.get(t, k) : () => {}) },
      ) as unknown as BuiltinDeps,
    ).some((c) => c.id === "file.deletePerm"),
  ).toBe(false);
});

it("L1: user rebinding disables defaults and alternates, and can shadow F4/F8", () => {
  const d = dispatchHarness();
  act(() =>
    useKeymap.setState({
      bindings: [
        { key: "Ctrl+K", command_id: "file.edit" },
        { key: "Ctrl+L", command_id: "file.delete" },
        { key: "F4", command_id: "file.rename" },
        { key: "F8", command_id: "file.newFolder" },
      ],
    }),
  );
  fireEvent.keyDown(window, { key: "F4" });
  fireEvent.keyDown(window, { key: "F8" });
  fireEvent.keyDown(window, { key: "Delete" });
  fireEvent.keyDown(window, { key: "F6", shiftKey: true });
  expect(d.rename).toHaveBeenCalledOnce();
  expect(d.newFolder).toHaveBeenCalledOnce();
  expect(d.editFile).not.toHaveBeenCalled();
  expect(d.trash).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: "K", ctrlKey: true });
  expect(d.editFile).toHaveBeenCalledOnce();
});

it("L1: text input/textarea and actual inline rename absorb F4/Shift+F6/F8", () => {
  const d = dispatchHarness();
  const done = vi.fn();
  render(
    <>
      <input aria-label="fixture input" />
      <textarea aria-label="fixture textarea" />
      <InlineRenameInput
        target={{
          location: { source: { kind: "local" }, path: "/fixture" },
          name: "fixture.txt",
        }}
        isDir={false}
        onDone={done}
      />
    </>,
  );
  for (const input of screen.getAllByRole("textbox")) {
    for (const event of [
      { key: "F4" },
      { key: "F6", shiftKey: true },
      { key: "F8" },
      { key: "F8", shiftKey: true },
      { key: "N", ctrlKey: true, shiftKey: true },
    ])
      fireEvent.keyDown(input, event);
  }
  expect(d.editFile).not.toHaveBeenCalled();
  expect(d.rename).not.toHaveBeenCalled();
  expect(d.trash).not.toHaveBeenCalled();
  expect(d.deletePerm).not.toHaveBeenCalled();
  expect(d.newFolder).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
});
