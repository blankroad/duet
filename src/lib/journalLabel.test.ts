import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { opLabel, shortLoc } from "./journalLabel";
import type { OpKind, UndoOutcome, UndoReason } from "@/types/bindings";

const source = { kind: "local" as const };
const src = { source, path: "/work/source" };
const dst = { source, path: "C:\\work\\destination" };
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("journal operation labels", () => {
  it("shares the History wording for every supported operation", async () => {
    await i18n.changeLanguage("en");
    const cases: [OpKind, string][] = [
      [
        { kind: "trash", count: 2, location: src },
        "Deleted 2 item(s) to trash — source",
      ],
      [
        { kind: "permanent_delete", count: 2, location: src },
        "Permanently deleted 2 item(s) — source",
      ],
      [{ kind: "copy", count: 2, src, dst }, "Copied 2 item(s) → destination"],
      [{ kind: "move", count: 2, src, dst }, "Moved 2 item(s) → destination"],
      [
        { kind: "rename", from: "old.txt", to: "new.txt", source },
        "Renamed old.txt → new.txt",
      ],
      [
        { kind: "batch_rename", count: 2, location: src },
        "Batch renamed 2 item(s) — source",
      ],
      [
        { kind: "mkdir", source, path: "C:\\work\\folder" },
        "New folder — folder",
      ],
      [
        { kind: "new_file", source, path: "/work/file.txt" },
        "New file — file.txt",
      ],
      [
        {
          kind: "extract",
          archive: { source, path: "/work/items.zip" },
          dest: dst,
        },
        "Extracted items.zip",
      ],
      [
        { kind: "compress", count: 2, dst },
        "Compressed 2 item(s) → destination",
      ],
      [
        { kind: "sync", count: 2, pruned: 0, src, dst },
        "Synced 2 item(s) → destination",
      ],
      [
        { kind: "sync", count: 2, pruned: 1, src, dst },
        "Synced 2 item(s), pruned 1 → destination",
      ],
      [
        { kind: "merge", to_left: 1, to_right: 2, left: src, right: dst },
        "Merged folders — 3 item(s)",
      ],
      [
        {
          kind: "compare_apply",
          applied: 2,
          overwritten: 0,
          left: src,
          right: dst,
        },
        "Compare apply — 2 item(s)",
      ],
      [
        {
          kind: "three_way_apply",
          applied: 2,
          conflicts: 0,
          base: src,
          left: src,
          right: dst,
        },
        "3-way apply — 2 item(s)",
      ],
    ];
    for (const [op, expected] of cases)
      expect(opLabel(op, i18n.t)).toBe(expected);
    expect(shortLoc({ source, path: "/" })).toBe("/");
  });

  it("uses the current translation for names", async () => {
    await i18n.changeLanguage("ko");
    expect(opLabel({ kind: "mkdir", source, path: "/work/폴더" }, i18n.t)).toBe(
      "새 폴더 — 폴더",
    );
  });
});

const undoMock = vi.hoisted(() => ({ undo: vi.fn(), redo: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: { undoLast: undoMock.undo, redoLast: undoMock.redo },
}));
import { triggerUndo, triggerRedo } from "./fileActions";
import type { ToastKind } from "@/stores/toast";

const operation: OpKind = {
  kind: "mkdir",
  source,
  path: "C:\\work\\named-folder",
};
function outcome(
  kind: UndoOutcome["kind"],
  reason: UndoReason | null = null,
): UndoOutcome {
  return {
    kind,
    op: operation,
    reason,
    skipped: [],
    message: "raw backend detail",
    refreshed_locations: [],
  };
}

for (const [direction, trigger, mock] of [
  ["undo", triggerUndo, undoMock.undo],
  ["redo", triggerRedo, undoMock.redo],
] as const) {
  describe(`${direction} outcome toasts`, () => {
    it.each([
      ["ok", null, "success"],
      ["partial", "changed", "warning"],
      ["stale", "occupied", "warning"],
      ["error", "unreachable", "error"],
      ["skipped", "redo_unsupported", "info"],
      ["irreversible", null, "warning"],
    ] as [UndoOutcome["kind"], UndoReason | null, ToastKind][])(
      "fileops-25: %s describes the operation in both languages",
      async (kind, reason, severity) => {
        for (const language of ["en", "ko"]) {
          await i18n.changeLanguage(language);
          const result = outcome(kind, reason);
          if (kind === "partial")
            result.skipped = [
              { path: "C:\\work\\changed.txt", reason: "changed" },
              { path: "/work/gone.txt", reason: "gone" },
            ];
          mock.mockResolvedValue({ status: "ok", data: result });
          const show = vi.fn();
          await trigger(show);
          const message: string = show.mock.calls[0]![0];
          expect(message).toContain(opLabel(operation, i18n.t));
          expect(message).not.toContain("raw backend detail");
          expect(message).not.toMatch(/\bok\b|undo\.|toast\./);
          expect(show.mock.calls[0]![1]).toBe(severity);
          if (kind === "partial")
            expect(message).toContain(
              language === "en" ? "contents changed" : "그 뒤 내용이 바뀜",
            );
          if (kind === "stale") {
            expect(message).toContain(
              language === "en"
                ? "another item occupies"
                : "그 자리에 다른 항목이 있음",
            );
            if (direction === "undo")
              expect(message).toContain(
                language === "en" ? "preceding operation" : "그 이전 작업",
              );
          }
          if (kind === "error")
            expect(message).toContain(
              language === "en" ? "cannot connect" : "연결할 수 없음",
            );
          if (kind === "partial") {
            expect(message).toContain("2");
            expect(message).toContain("changed.txt");
            expect(message).not.toContain("C:\\work");
          }
          if (["error", "partial", "stale", "irreversible"].includes(kind))
            expect(show.mock.calls[0]![2]).toEqual({
              detail: "raw backend detail",
            });
        }
      },
    );

    it.each(["partial", "stale", "irreversible"] as const)(
      "%s without a backend note remains info",
      async (kind) => {
        const data = { ...outcome(kind, "changed"), message: null };
        mock.mockResolvedValue({ status: "ok", data });
        const show = vi.fn();
        await trigger(show);
        expect(show.mock.calls[0]![1]).toBe("info");
        expect(show.mock.calls[0]![2]).toEqual({ detail: undefined });
      },
    );

    it("describes an empty stack without inventing an operation", async () => {
      await i18n.changeLanguage("en");
      mock.mockResolvedValue({
        status: "ok",
        data: {
          ...outcome(
            "skipped",
            direction === "undo" ? "nothing_to_undo" : "nothing_to_redo",
          ),
          op: null,
        },
      });
      const show = vi.fn();
      await trigger(show);
      expect(show.mock.calls[0]![0]).toBe(
        direction === "undo" ? "Nothing to undo" : "Nothing to redo",
      );
      expect(show.mock.calls[0]![1]).toBe("info");
    });

    it("keeps transport errors visible", async () => {
      await i18n.changeLanguage("en");
      mock.mockResolvedValue({
        status: "error",
        error: { kind: "PermissionDenied", message: "permission denied" },
      });
      const show = vi.fn();
      await trigger(show);
      expect(show.mock.calls[0]![0]).toContain(
        direction === "undo" ? "Undo failed:" : "Redo failed:",
      );
      expect(show.mock.calls[0]![1]).toBe("error");
    });
  });
}
