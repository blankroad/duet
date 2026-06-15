import { describe, it, expect } from "vitest";
import { buildCompareTree, diffCount } from "./compareTree";
import type { CompareEntry, CompareStatus } from "@/types/bindings";

const e = (rel: string, status: CompareStatus, kind: "file" | "dir" = "file"): CompareEntry => ({
  rel,
  kind,
  status,
  left_size: null,
  right_size: null,
  left_mtime_ms: null,
  right_mtime_ms: null,
});

describe("buildCompareTree", () => {
  it("groups nested rels into folders with synthetic containers", () => {
    const tree = buildCompareTree([
      e("sub/a.txt", "left_only"),
      e("sub/b.txt", "differ"),
      e("top.txt", "right_only"),
    ]);
    // 폴더(sub) 먼저, 그다음 파일(top.txt).
    expect(tree.map((n) => n.name)).toEqual(["sub", "top.txt"]);
    const sub = tree[0]!;
    expect(sub.children?.map((c) => c.name)).toEqual(["a.txt", "b.txt"]);
    expect(sub.entry).toBeUndefined(); // 합성 폴더
    expect(sub.children?.[0]?.entry?.status).toBe("left_only");
  });

  it("rolls up descendant statuses on folder nodes", () => {
    const tree = buildCompareTree([
      e("d/x", "left_only"),
      e("d/y", "left_only"),
      e("d/z", "differ"),
    ]);
    const d = tree[0]!;
    expect(d.rollup.left_only).toBe(2);
    expect(d.rollup.differ).toBe(1);
    expect(diffCount(d.rollup)).toBe(3);
  });

  it("one-side-only directory is a leaf (not expanded)", () => {
    const tree = buildCompareTree([e("newdir", "left_only", "dir")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.entry?.kind).toBe("dir");
    expect(tree[0]?.children).toBeUndefined();
  });

  it("nested folders build a chain", () => {
    const tree = buildCompareTree([e("a/b/c.txt", "differ")]);
    const a = tree[0]!;
    expect(a.name).toBe("a");
    expect(a.children?.[0]?.name).toBe("b");
    expect(a.children?.[0]?.children?.[0]?.name).toBe("c.txt");
    expect(a.rollup.differ).toBe(1);
  });
});
