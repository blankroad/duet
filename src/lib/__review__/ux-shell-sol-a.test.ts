import { beforeEach, expect, it, vi } from "vitest";
import type { Entry, Location } from "@/types/bindings";

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "windows" }));
const h = vi.hoisted(() => ({
  mirror: vi.fn(),
  reveal: vi.fn(),
  terminal: vi.fn(),
  launch: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({
  commands: {
    setOsFileClipboard: h.mirror,
    revealPath: h.reveal,
    openTerminal: h.terminal,
    appLaunch: h.launch,
  },
}));

import { buildBuiltins, type BuiltinDeps } from "@/lib/commands";
import { resolveKeyCommand } from "@/stores/keymap";
import { buildEntryMenu } from "@/lib/entryMenu";
import { isSeparator } from "@/stores/contextMenu";
import { clipCopy, clipCut } from "@/lib/fileActions";
import { usePanes } from "@/stores/panes";
import { launchApp } from "@/stores/appLaunchers";
import { useToast } from "@/stores/toast";
import { useClipboard } from "@/stores/clipboard";

const local: Location = { source: { kind: "local" }, path: "/fixture" };
const entries: Entry[] = ["one.txt", "two.txt"].map((name) => ({
  name,
  kind: "file",
  size: 1,
  modified_ms: null,
  permissions: null,
  hidden: false,
}));

beforeEach(() => {
  h.mirror.mockReset().mockResolvedValue({ status: "ok", data: null });
  usePanes.getState().setActivePane("left");
  usePanes.getState().setEntries("left", local, entries);
  usePanes.getState().setSelected(
    "left",
    entries.map((e) => e.name),
  );
});

it.fails("UX-SHL-01: F4 reaches the supplied edit-file action", () => {
  const editFile = vi.fn();
  const deps = new Proxy(
    { editFile, permanentDeleteEnabled: false },
    {
      get: (t, k) => (k in t ? Reflect.get(t, k) : () => {}),
    },
  ) as unknown as BuiltinDeps;
  const commands = buildBuiltins(deps);
  const id = resolveKeyCommand("F4", [], commands);
  expect(id).toBeDefined();
  commands.find((c) => c.id === id)?.action();
  expect(editFile).toHaveBeenCalledOnce();
});

it.fails("UX-SHL-02: multi-file context menu offers external Open", () => {
  const menu = buildEntryMenu({
    paneId: "left",
    entry: entries[0]!,
    location: local,
    selectedCount: 2,
    onActivate: vi.fn(),
    onOpenInOtherPane: vi.fn(),
  });
  expect(menu.some((item) => !isSeparator(item) && item.id === "open")).toBe(
    true,
  );
});

it.each([clipCopy, clipCut])(
  "mirrors both selected local files and preserves in-app mode (%#)",
  (action) => {
    action(vi.fn());
    expect(h.mirror).toHaveBeenCalledWith(
      entries.map((e) => ({ location: local, name: e.name })),
    );
    expect(useClipboard.getState().entry?.mode).toBe(
      action === clipCopy ? "copy" : "move",
    );
  },
);

it("forwards remote selections to backend; in-app clipboard survives unsupported OS export", () => {
  const remote: Location = {
    source: {
      kind: "ssh",
      connection_id: "fixture",
      host_ip: "127.0.0.1",
      user: "fixture",
    },
    path: "/remote",
  };
  h.mirror.mockResolvedValue({
    status: "error",
    error: { kind: "NotSupported", data: "remote" },
  });
  usePanes.getState().setEntries("left", remote, entries);
  usePanes.getState().setSelected(
    "left",
    entries.map((e) => e.name),
  );
  clipCopy(vi.fn());
  expect(h.mirror).toHaveBeenCalledWith(
    entries.map((e) => ({ location: remote, name: e.name })),
  );
  expect(useClipboard.getState().entry?.targets).toHaveLength(2);
});

it("empty selection and empty listing leave the OS clipboard alone", () => {
  usePanes.getState().setEntries("left", local, []);
  usePanes.getState().setSelected("left", []);
  const toast = vi.fn();
  clipCopy(toast);
  clipCut(toast);
  expect(h.mirror).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledTimes(2);
});

it("single local reveal/terminal and missing launcher failures reach error feedback", async () => {
  const show = vi.spyOn(useToast.getState(), "show");
  const error = {
    status: "error",
    error: { kind: "Io", message: "fixture launch failure" },
  };
  h.reveal.mockResolvedValue(error);
  h.terminal.mockResolvedValue(error);
  h.launch.mockResolvedValue(error);
  const dir: Entry = { ...entries[0]!, name: "folder", kind: "dir" };
  const menu = buildEntryMenu({
    paneId: "left",
    entry: dir,
    location: local,
    selectedCount: 1,
    onActivate: vi.fn(),
    onOpenInOtherPane: vi.fn(),
  });
  for (const id of ["reveal", "open-terminal"]) {
    const item = menu.find((e) => !isSeparator(e) && e.id === id);
    if (item && !isSeparator(item)) item.onSelect?.();
  }
  await launchApp("/fixture/missing-app", ["fixture-arg"]);
  await Promise.resolve();
  expect(h.reveal).toHaveBeenCalledWith({ ...local, path: "/fixture/folder" });
  expect(h.terminal).toHaveBeenCalledWith({
    ...local,
    path: "/fixture/folder",
  });
  expect(h.launch).toHaveBeenCalledWith("/fixture/missing-app", [
    "fixture-arg",
  ]);
  expect(show).toHaveBeenCalledTimes(3);
  show.mockRestore();
});
