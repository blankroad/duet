import { describe, it, expect } from "vitest";
import { lineDiff } from "./lineDiff";

describe("lineDiff", () => {
  it("identical → all context", () => {
    const ops = lineDiff(["a", "b"], ["a", "b"]);
    expect(ops.every((o) => o.t === "ctx")).toBe(true);
    expect(ops.map((o) => o.text)).toEqual(["a", "b"]);
  });

  it("one line changed → del + add", () => {
    const ops = lineDiff(["a", "x", "c"], ["a", "y", "c"]);
    expect(ops).toEqual([
      { t: "ctx", text: "a" },
      { t: "del", text: "x" },
      { t: "add", text: "y" },
      { t: "ctx", text: "c" },
    ]);
  });

  it("insertion", () => {
    const ops = lineDiff(["a", "c"], ["a", "b", "c"]);
    expect(ops.filter((o) => o.t === "add").map((o) => o.text)).toEqual(["b"]);
    expect(ops.filter((o) => o.t === "del")).toHaveLength(0);
  });

  it("deletion", () => {
    const ops = lineDiff(["a", "b", "c"], ["a", "c"]);
    expect(ops.filter((o) => o.t === "del").map((o) => o.text)).toEqual(["b"]);
    expect(ops.filter((o) => o.t === "add")).toHaveLength(0);
  });

  it("empty sides", () => {
    expect(lineDiff([], [])).toEqual([]);
    expect(lineDiff(["a"], [])).toEqual([{ t: "del", text: "a" }]);
    expect(lineDiff([], ["b"])).toEqual([{ t: "add", text: "b" }]);
  });
});
