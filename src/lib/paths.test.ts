import { describe, it, expect } from "vitest";
import { basename, pathSegments } from "@/lib/paths";

describe("basename", () => {
  it("POSIX 경로의 마지막 세그먼트", () => {
    expect(basename("/Users/foo/Documents")).toBe("Documents");
  });

  it("Windows 역슬래시 경로 — 전체 경로로 새지 않음 (회귀 방지)", () => {
    expect(basename("D:\\test\\test1\\test2")).toBe("test2");
  });

  it("혼합 구분자도 마지막 세그먼트", () => {
    expect(basename("C:/Users\\foo/bar")).toBe("bar");
  });

  it("후행 구분자는 무시", () => {
    expect(basename("/a/b/")).toBe("b");
    expect(basename("D:\\a\\b\\")).toBe("b");
  });

  it("세그먼트가 없으면 fallback", () => {
    expect(basename("/")).toBe("/");
    expect(basename("", "archive")).toBe("archive");
    expect(basename("\\", "archive")).toBe("archive");
  });
});

describe("pathSegments", () => {
  it("'/'·'\\' 모두 분해하고 빈 조각 제거", () => {
    expect(pathSegments("/a/b//c")).toEqual(["a", "b", "c"]);
    expect(pathSegments("D:\\a\\b")).toEqual(["D:", "a", "b"]);
  });
});
