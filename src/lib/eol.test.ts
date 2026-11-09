import { describe, expect, it } from "vitest";
import { detectLineEnding, splitLines } from "./eol";

describe("eol", () => {
  it("줄 끝 방식을 판정한다", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("crlf");
    expect(detectLineEnding("a\nb\n")).toBe("lf");
    expect(detectLineEnding("a\r\nb\n")).toBe("mixed");
    expect(detectLineEnding("한 줄")).toBeNull();
    expect(detectLineEnding("")).toBeNull();
  });

  it("줄 끝의 \\r 만 떼고 나눈다(줄 중간 \\r 은 유지)", () => {
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b", ""]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
    expect(splitLines("x\ry\r\n")).toEqual(["x\ry", ""]);
  });
});
