import { describe, it, expect } from "vitest";
import { matchesQuery, matchRange } from "./sidebarFilter";

describe("sidebarFilter", () => {
  it("빈 질의는 모두 통과", () => {
    expect(matchesQuery("prod", "")).toBe(true);
    expect(matchesQuery("prod", "   ")).toBe(true);
    expect(matchRange("prod", "")).toBeNull();
  });

  it("대소문자 무시 부분일치", () => {
    expect(matchesQuery("Macintosh HD", "hd")).toBe(true);
    expect(matchesQuery("deploy-log", "LOG")).toBe(true);
    expect(matchesQuery("prod", "stag")).toBe(false);
  });

  /**
   * 퍼지 매칭이 아니다 — 짧고 비슷한 호스트 이름에서 퍼지는 관계없는 항목을 다 남긴다.
   * 회귀 방지: "pd" 로 "prod" 가 걸리면 안 된다.
   */
  it("띄엄띄엄 글자는 매치가 아니다", () => {
    expect(matchesQuery("prod", "pd")).toBe(false);
  });

  it("매치 구간을 돌려준다", () => {
    expect(matchRange("deploy-log", "log")).toEqual({ start: 7, end: 10 });
    expect(matchRange("logrotate", "log")).toEqual({ start: 0, end: 3 });
    expect(matchRange("prod", "log")).toBeNull();
  });

  it("G-14: NFD 이름(macOS)도 NFC 입력으로 찾고, 강조는 원문 음절 경계에 맞춘다", () => {
    const nfd = "내 회의록".normalize("NFD");
    expect(matchesQuery(nfd, "회의")).toBe(true);
    const r = matchRange(nfd, "회의");
    expect(r).not.toBeNull();
    // 강조 구간을 원문에서 잘라 NFC 로 바꾸면 정확히 "회의" 다(자모 중간에서 끊기지 않음).
    expect(nfd.slice(r!.start, r!.end).normalize("NFC")).toBe("회의");
    // NFD 입력 ↔ NFC 이름도 같다.
    expect(matchRange("내 회의록", "회의".normalize("NFD"))).toEqual({
      start: 2,
      end: 4,
    });
  });

  it("공백은 다듬고 찾는다", () => {
    expect(matchRange("deploy-log", "  log ")).toEqual({ start: 7, end: 10 });
  });
});
