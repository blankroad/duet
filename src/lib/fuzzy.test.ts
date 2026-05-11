import { describe, it, expect } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("empty query matches all (score 0)", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("subsequence match returns positive score", () => {
    expect(fuzzyScore("ot", "openTab")).toBeGreaterThan(0);
  });

  it("non-subsequence returns null", () => {
    expect(fuzzyScore("xyz", "openTab")).toBeNull();
  });

  it("case insensitive", () => {
    expect(fuzzyScore("OT", "openTab")).toBeGreaterThan(0);
    expect(fuzzyScore("ot", "OPENTAB")).toBeGreaterThan(0);
  });

  it("contiguous match scores higher than scattered", () => {
    const contiguous = fuzzyScore("open", "open tab")!;
    const scattered = fuzzyScore("open", "outside p eraser n")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("word-boundary match scores higher", () => {
    const boundary = fuzzyScore("nt", "newTab")!;
    const middle = fuzzyScore("nt", "consonant")!;
    expect(boundary).toBeGreaterThan(middle);
  });

  it("perfect prefix scores high", () => {
    const prefix = fuzzyScore("new", "newTab")!;
    const middle = fuzzyScore("new", "renew")!;
    expect(prefix).toBeGreaterThan(middle);
  });
});
