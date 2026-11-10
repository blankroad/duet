// UX smoke (2026-11-10, fileops, opus) — mocked FE test. Tauri commands are mocked;
// this is NOT a live-app test. It checks what the FE does when a user presses a key or
// picks a menu item, across none/single/multi selection.
//
// `it.fails("ux-fileops-NN: …")` reproduces a defect (passes today because the
// expectation fails). Remove `.fails` once fixed and it becomes a regression test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entry, Location } from "@/types/bindings";

const h = vi.hoisted(() => ({
  platform: "windows" as string,
  calls: [] as Array<[string, unknown[]]>,
  plan: { status: "ok", data: null } as unknown,
}));

vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => h.platform }));
vi.mock("@/types/bindings", () => {
  const rec =
    (name: string, result: () => unknown) =>
    (...args: unknown[]) => {
      h.calls.push([name, args]);
      return Promise.resolve(result());
    };
  return {
    commands: {
      fsCopyPlan: rec("fsCopyPlan", () => h.plan),
      fsMovePlan: rec("fsMovePlan", () => h.plan),
      fsDeletePlan: rec("fsDeletePlan", () => h.plan),
      fsCopyExecute: rec("fsCopyExecute", () => ({ status: "ok", data: "t" })),
      fsMoveExecute: rec("fsMoveExecute", () => ({ status: "ok", data: "t" })),
      fsDeleteExecute: rec("fsDeleteExecute", () => ({
        status: "ok",
        data: "t",
      })),
      setOsFileClipboard: rec("setOsFileClipboard", () => ({
        status: "ok",
        data: null,
      })),
    },
  };
});

import i18n from "@/i18n";
import { buildBuiltins } from "@/lib/commands";
import { resolveKeyCommand } from "@/stores/keymap";
import { explainError } from "@/lib/error";
import {
  clipCopy,
  clipCut,
  planTransferTo,
  triggerDelete,
  triggerMove,
  triggerRename,
} from "@/lib/fileActions";
import { usePanes } from "@/stores/panes";
import { useClipboard } from "@/stores/clipboard";
import { useUI } from "@/stores/ui";
import { VIRTUAL_TRASH_PATH } from "@/lib/trashView";

const deps = (permanentDeleteEnabled: boolean) =>
  new Proxy(
    { permanentDeleteEnabled },
    {
      get: (t, k) =>
        k in t ? (t as Record<string, unknown>)[k as string] : () => {},
    },
  ) as Parameters<typeof buildBuiltins>[0];

/** Which command a key would run with no user keymap overrides. */
const keyRuns = (key: string, permanentDelete = true) =>
  resolveKeyCommand(key, [], buildBuiltins(deps(permanentDelete)));

const file = (name: string, kind: "file" | "dir" = "file"): Entry =>
  ({
    name,
    kind,
    size: 1,
    modified_ms: 0,
    permissions: null,
    hidden: false,
  }) as Entry;

const local = (path: string): Location => ({
  source: { kind: "local" },
  path,
});

/** Seed both panes: left is active. `cursor` indexes the displayed list (".." first). */
function seed(opts: {
  left: Location;
  right: Location;
  entries?: Entry[];
  selected?: string[];
  cursor?: number;
}) {
  usePanes.setState((s) => {
    const tab = (id: "left" | "right", loc: Location, entries: Entry[]) => ({
      tabs: [
        {
          ...s.panes[id].tabs[0]!,
          location: loc,
          entries,
          cursorIndex: id === "left" ? (opts.cursor ?? -1) : -1,
          selected: new Set(id === "left" ? (opts.selected ?? []) : []),
          filter: "",
          showHidden: false,
          sortKey: "name" as const,
          sortOrder: "asc" as const,
          history: { stack: [loc], index: 0 },
        },
      ],
      activeTabIndex: 0,
    });
    return {
      panes: {
        left: tab("left", opts.left, opts.entries ?? []),
        right: tab("right", opts.right, []),
      },
      activePane: "left" as const,
    };
  });
}

beforeEach(() => {
  h.platform = "windows";
  h.calls = [];
  h.plan = { status: "ok", data: null };
  useClipboard.getState().clear();
});

// ── Shortcuts: DESIGN.md "File ops (TC 호환)" table vs the default keymap ──

describe("fileops shortcuts (Windows/Linux defaults)", () => {
  it.each([
    ["F2", "file.rename"],
    ["F5", "file.copy"],
    ["F6", "file.move"],
    ["F7", "file.newFolder"],
    ["Shift+F4", "file.newFile"],
    ["Delete", "file.delete"],
    ["Shift+Delete", "file.deletePerm"],
    ["Ctrl+C", "file.clipCopy"],
    ["Ctrl+X", "file.clipCut"],
    ["Ctrl+V", "file.clipPaste"],
    ["Ctrl+Z", "edit.undo"],
    ["Ctrl+Shift+Z", "edit.redo"],
  ])("%s runs %s", (key, id) => {
    expect(keyRuns(key)).toBe(id);
  });

  it("Shift+Delete does nothing while permanent delete is off (§3)", () => {
    expect(keyRuns("Shift+Delete", false)).toBeUndefined();
  });

  // DESIGN.md lists these as the TC-compatible alternates; none is registered.
  it.fails("ux-fileops-03: F8 deletes to trash (DESIGN.md)", () => {
    expect(keyRuns("F8")).toBe("file.delete");
  });
  it.fails("ux-fileops-03: Shift+F8 deletes permanently (DESIGN.md)", () => {
    expect(keyRuns("Shift+F8")).toBe("file.deletePerm");
  });
  it.fails("ux-fileops-03: Ctrl+Shift+N makes a new folder (DESIGN.md)", () => {
    expect(keyRuns("Ctrl+Shift+N")).toBe("file.newFolder");
  });
  it.fails("ux-fileops-03: Shift+F6 renames (DESIGN.md)", () => {
    expect(keyRuns("Shift+F6")).toBe("file.rename");
  });
  it("there is no default key for Operation history (palette/TopBar only)", () => {
    const cmds = buildBuiltins(deps(true));
    expect(cmds.find((c) => c.id === "edit.history")?.defaultKey).toBe(
      undefined,
    );
  });
});

describe("fileops shortcuts (macOS defaults)", () => {
  // Mac keyboards have no forward-Delete key without fn; Finder's trash key is ⌘⌫.
  // keyEvent maps ⌘ to "Ctrl", so ⌘⌫ arrives as "Ctrl+Backspace".
  it.fails(
    "ux-fileops-04: ⌘⌫ (Ctrl+Backspace) moves the selection to trash",
    () => {
      h.platform = "macos";
      expect(keyRuns("Ctrl+Backspace")).toBe("file.delete");
    },
  );
  it("plain Backspace is not bound to delete (it goes up a folder)", () => {
    h.platform = "macos";
    expect(keyRuns("Backspace")).toBeUndefined();
  });
});

// ── Selection: none / single / multi ──

describe("no selection, cursor on '..'", () => {
  const here = local("C:\\work");
  const there = local("D:\\backup");

  it("F5/F6/Ctrl+C/Ctrl+X explain that nothing is selected", async () => {
    seed({ left: here, right: there, entries: [file("a.txt")], cursor: 0 });
    const toast = vi.fn();
    clipCopy(toast);
    clipCut(toast);
    await triggerMove(vi.fn(), toast);
    expect(toast).toHaveBeenCalledTimes(3);
    expect(h.calls.filter(([n]) => n.endsWith("Plan"))).toEqual([]);
  });

  it("F2 explains that one item must be selected", () => {
    seed({ left: here, right: there, entries: [file("a.txt")], cursor: 0 });
    const toast = vi.fn();
    triggerRename(toast);
    expect(toast).toHaveBeenCalledWith(i18n.t("toast.renameSelectOne"));
  });

  it("ux-fileops-05: Delete with nothing selected tells the user why nothing happened", async () => {
    seed({ left: here, right: there, entries: [file("a.txt")], cursor: 0 });
    const toast = vi.fn();
    await triggerDelete("trash", vi.fn(), toast);
    expect(h.calls).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});

describe("multi selection", () => {
  const here = local("/w");
  it("Delete plans every selected item once", async () => {
    seed({
      left: here,
      right: local("/x"),
      entries: [file("a.txt"), file("b.txt"), file("d", "dir")],
      selected: ["a.txt", "d"],
      cursor: 1,
    });
    await triggerDelete("trash", vi.fn(), vi.fn());
    const del = h.calls.find(([n]) => n === "fsDeletePlan");
    const names = (del?.[1][0] as Array<{ name: string }>).map((t) => t.name);
    expect(names.sort()).toEqual(["a.txt", "d"]);
  });

  it("F2 on a multi selection does not start an inline rename", () => {
    seed({
      left: here,
      right: local("/x"),
      entries: [file("a.txt"), file("b.txt")],
      selected: ["a.txt", "b.txt"],
    });
    const toast = vi.fn();
    triggerRename(toast);
    expect(toast).toHaveBeenCalledWith(i18n.t("toast.renameSelectOne"));
  });
});

// ── Same folder in both panes ──

describe("both panes show the same folder", () => {
  const here = local("/w");
  it.fails(
    "ux-fileops-01: F6 says 'already in this folder' instead of planning a move onto itself",
    async () => {
      seed({
        left: here,
        right: here,
        entries: [file("a.txt")],
        selected: ["a.txt"],
      });
      const toast = vi.fn();
      await triggerMove(vi.fn(), toast);
      expect(h.calls.find(([n]) => n === "fsMovePlan")).toBeUndefined();
      expect(toast).toHaveBeenCalledWith(i18n.t("toast.alreadyInFolder"));
    },
  );
});

// ── Windows Recycle Bin view (virtual path, not a real folder) ──

describe("Windows Recycle Bin view", () => {
  const bin = local(VIRTUAL_TRASH_PATH);
  it("F6 out of the bin is refused with the put-back hint", async () => {
    seed({
      left: bin,
      right: local("C:\\x"),
      entries: [file("a.txt")],
      selected: ["a.txt"],
    });
    const toast = vi.fn();
    await triggerMove(vi.fn(), toast);
    expect(toast).toHaveBeenCalledWith(
      i18n.t("toast.trashOnlyPutBack"),
      "error",
    );
  });

  it("ux-fileops-06: Ctrl+X in the bin is refused like F6 (else Ctrl+V plans a move from a virtual path)", () => {
    seed({
      left: bin,
      right: local("C:\\x"),
      entries: [file("a.txt")],
      selected: ["a.txt"],
    });
    clipCut(vi.fn());
    expect(useClipboard.getState().entry).toBeNull();
  });

  it("ux-fileops-06: Ctrl+C in the bin is refused like F5", () => {
    seed({
      left: bin,
      right: local("C:\\x"),
      entries: [file("a.txt")],
      selected: ["a.txt"],
    });
    clipCopy(vi.fn());
    expect(useClipboard.getState().entry).toBeNull();
  });

  it("ux-fileops-06: F2 in the bin does not open an inline rename on a virtual entry", () => {
    seed({
      left: bin,
      right: local("C:\\x"),
      entries: [file("a.txt")],
      selected: ["a.txt"],
    });
    const spy = vi.fn();
    useUI.setState({ requestInlineRename: spy });
    triggerRename(vi.fn());
    expect(spy).not.toHaveBeenCalled();
  });
  // Drag/drop (useEntryDrag, sidebar drop) calls planTransferTo directly; only the
  // F5/F6/Ctrl+V triggers check for the bin. Static reading: dropping onto a bin pane
  // plans a copy into the virtual path. Windows-only path, not run on a device.
  it("ux-fileops-06: a drop onto the bin pane does not plan a copy into the virtual path", async () => {
    const toast = vi.fn();
    await planTransferTo(
      [{ location: local("C:\\x"), name: "a.txt" }],
      bin,
      "copy",
      vi.fn(),
      toast,
    );
    expect(h.calls.find(([n]) => n === "fsCopyPlan")).toBeUndefined();
  });
});

// ── Error text for backend refusals the user hits in normal use ──

describe("error toasts for common refusals (ko)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("ko");
  });

  it.fails(
    "ux-fileops-02: rename onto an existing name reads as 'already exists', not raw English",
    () => {
      const why = explainError({
        kind: "Io",
        message: "target exists: /w/b.txt",
      });
      expect(why.text).not.toMatch(/target exists/i);
      expect(why.text).toContain(
        i18n.t("errors.reason.exists", { defaultValue: "" }).slice(0, 4),
      );
    },
  );

  it.fails(
    "ux-fileops-02: batch rename collision is explained in Korean",
    () => {
      const why = explainError({
        kind: "Io",
        message: "batch rename: name collision — resolve before applying",
      });
      expect(why.text).not.toMatch(/[A-Za-z]{4,}/);
    },
  );

  it.fails(
    "ux-fileops-02: batch rename with no changes is explained in Korean",
    () => {
      const why = explainError({
        kind: "Io",
        message: "batch rename: nothing to rename",
      });
      expect(why.text).not.toMatch(/[A-Za-z]{4,}/);
    },
  );
});
