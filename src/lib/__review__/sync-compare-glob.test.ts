import { describe, expect, it } from "vitest";
import { patternToMatcher } from "../glob";
import { explainError } from "../error";

describe("sync-compare: FE glob contract for backend comparison", () => {
  it.each<[string, string, boolean]>([
    ["*.log", "trace.log", true],
    ["*.LOG", "trace.log", true],
    ["node_modules", "my_node_modules_cache", true],
    ["a/b", "b", false],
    ["**/x", "x", false],
    ["[abc]", "a", true],
  ])("%s / %s -> %s", (pattern, name, expected) => {
    expect(patternToMatcher(pattern)(name)).toBe(expected);
  });

  it("keeps the unsupported sync combination detail visible", () => {
    const message =
      "sync supports local↔local and same-host SSH only (cross-host relay is a follow-up)";
    const result = explainError({ kind: "NotSupported", message }, "windows");
    // SC-15: 문장은 쉬운 안내, 원문은 detail 에.
    expect(result.text).not.toContain(message);
    expect(result.detail).toBe(message);
  });
});
