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
    // LF 가 뒤따르지 않는 CR 은 내용 — "abc\r" 와 "abc" 를 같게 보이면 안 된다(R2-4).
    expect(splitLines("abc\r")).toEqual(["abc\r"]);
    expect(splitLines("a\r\r\nb")).toEqual(["a\r", "b"]);
  });
});
