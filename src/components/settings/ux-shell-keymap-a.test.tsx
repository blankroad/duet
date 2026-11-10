import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
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
