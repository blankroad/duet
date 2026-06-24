import { describe, it, expect } from "vitest";
import { patternToMatcher } from "./glob";

describe("patternToMatcher", () => {
  it("matches by extension glob", () => {
    const m = patternToMatcher("*.ts");
    expect(m("index.ts")).toBe(true);
    expect(m("a.b.ts")).toBe(true);
    expect(m("index.tsx")).toBe(false);
    expect(m("ts")).toBe(false);
  });

  it("treats ? as single char", () => {
    const m = patternToMatcher("img_??.png");
    expect(m("img_01.png")).toBe(true);
    expect(m("img_9.png")).toBe(false); // 한 글자 모자람
    expect(m("img_123.png")).toBe(false); // 한 글자 초과
  });

  it("supports character classes", () => {
    const m = patternToMatcher("[ab]*.log");
    expect(m("apple.log")).toBe(true);
    expect(m("banana.log")).toBe(true);
    expect(m("cherry.log")).toBe(false);
  });

  it("falls back to substring when no glob meta", () => {
    const m = patternToMatcher("report");
    expect(m("q1_report_final.pdf")).toBe(true);
    expect(m("summary.txt")).toBe(false);
  });

  it("is case-insensitive in both modes", () => {
    expect(patternToMatcher("*.PNG")("photo.png")).toBe(true);
    expect(patternToMatcher("Read")("README.md")).toBe(true);
  });

  it("empty / whitespace pattern matches nothing", () => {
    expect(patternToMatcher("")("anything")).toBe(false);
    expect(patternToMatcher("   ")("anything")).toBe(false);
  });

  it("anchors glob to full name (not substring)", () => {
    const m = patternToMatcher("a*z");
    expect(m("abcz")).toBe(true);
    expect(m("xabcz")).toBe(false); // 시작 앵커
    expect(m("abczx")).toBe(false); // 끝 앵커
  });

  it("treats an unclosed [ as a literal (anchored)", () => {
    // 미완 문자클래스 '[' → 리터럴 '[' 로 변환되어 앵커드 전체 매칭.
    const m = patternToMatcher("file[");
    expect(m("file[")).toBe(true);
    expect(m("file[1]")).toBe(false);
  });
});
