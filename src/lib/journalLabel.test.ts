import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { opLabel, shortLoc } from "./journalLabel";
import type { OpKind } from "@/types/bindings";

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
