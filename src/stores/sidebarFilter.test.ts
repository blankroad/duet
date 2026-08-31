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

  it("공백은 다듬고 찾는다", () => {
    expect(matchRange("deploy-log", "  log ")).toEqual({ start: 7, end: 10 });
  });
});
