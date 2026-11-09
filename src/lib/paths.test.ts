import { describe, it, expect } from "vitest";
import { basename, pathSegments, shortenPath, splitRoot } from "@/lib/paths";

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

describe("shortenPath", () => {
  it("max 이하면 그대로", () => {
    expect(shortenPath("/a/b/c", 44)).toBe("/a/b/c");
  });

  it("가운데를 접고 말단(파일명)은 반드시 남긴다", () => {
    const p = "/Users/ctmctm/Desktop/01_PROJECT/duet/src/assets/report.pdf";
    const out = shortenPath(p, 44);
    expect(out.length).toBeLessThanOrEqual(44);
    expect(out).toContain("…");
    expect(out.endsWith("report.pdf")).toBe(true);
    expect(out.startsWith("/Users")).toBe(true);
  });

  it("여유가 있으면 뒤 세그먼트를 더 채운다", () => {
    const p = "/Users/ctmctm/Desktop/01_PROJECT/duet/src/assets/report.pdf";
    expect(shortenPath(p, 44)).toBe("/Users/…/duet/src/assets/report.pdf");
  });

  it("말단 세그먼트 자체가 max 보다 길면 문자 단위 가운데 생략", () => {
    const long = "/dir/" + "x".repeat(80) + ".bin";
    const out = shortenPath(long, 30);
    expect(out.length).toBeLessThanOrEqual(31); // keep*2 + '…'
    expect(out).toContain("…");
  });

  it("Windows 경로도 말단을 남긴다", () => {
    const out = shortenPath("D:\\work\\projects\\duet\\src\\report.pdf", 28);
    expect(out).toContain("…");
    expect(out.endsWith("report.pdf")).toBe(true);
  });
});

describe("pathSegments", () => {
  it("'/'·'\\' 모두 분해하고 빈 조각 제거", () => {
    expect(pathSegments("/a/b//c")).toEqual(["a", "b", "c"]);
    expect(pathSegments("D:\\a\\b")).toEqual(["D:", "a", "b"]);
  });
});

describe("splitRoot", () => {
  it.each([
    ["/", "/", ""],
    ["/home/u", "/", "home/u"],
    ["/한글 폴더/", "/", "한글 폴더/"],
    ["C:\\", "C:\\", ""],
    ["C:/", "C:\\", ""],
    ["C:", "C:\\", ""],
    ["c:\\Users\\space name", "c:\\", "Users\\space name"],
    ["C:\\한글 폴더\\", "C:\\", "한글 폴더\\"],
    ["\\\\srv\\share", "\\\\srv\\share", ""],
    ["\\\\srv\\share\\", "\\\\srv\\share", ""],
    ["\\\\서버\\공유\\한글 폴더\\", "\\\\서버\\공유", "한글 폴더\\"],
    ["\\\\srv", "\\\\srv", ""],
    ["\\\\?\\C:\\", "\\\\?\\C:\\", ""],
    ["\\\\?\\C:\\long\\x", "\\\\?\\C:\\", "long\\x"],
    ["\\\\?\\UNC\\srv\\share\\dir", "\\\\?\\UNC\\srv\\share", "dir"],
    ["\\\\?\\unc\\srv\\share", "\\\\?\\UNC\\srv\\share", ""],
    ["\\\\.\\PhysicalDrive0", "\\\\.\\PhysicalDrive0\\", ""],
    ["\\\\?\\Volume{abc}\\dir", "\\\\?\\Volume{abc}\\", "dir"],
  ])("%s → root %s, rest %s", (path, root, rest) => {
    expect(splitRoot(path)).toEqual({ root, rest });
  });

  it("rest 는 원문의 끝 조각이다 (원문 위치 계산용)", () => {
    const p = "C:/Users/foo";
    const r = splitRoot(p)!;
    expect(p.slice(p.length - r.rest.length)).toBe("Users/foo");
  });

  it("상대 경로는 루트가 없다", () => {
    expect(splitRoot("")).toBeNull();
    expect(splitRoot("docs/a")).toBeNull();
    expect(splitRoot("C:docs")).toBeNull();
  });

  it("//srv/share 는 windows 에서만 UNC — 소스를 모르면 POSIX 루트", () => {
    expect(splitRoot("//srv/share/dir", "windows")).toEqual({
      root: "\\\\srv\\share",
      rest: "dir",
    });
    expect(splitRoot("//srv/share/dir")).toEqual({
      root: "/",
      rest: "srv/share/dir",
    });
  });

  it("posix 는 / 만 루트로 본다", () => {
    expect(splitRoot("/srv/app", "posix")).toEqual({
      root: "/",
      rest: "srv/app",
    });
    expect(splitRoot("C:\\x", "posix")).toBeNull();
    expect(splitRoot("\\\\srv\\share", "posix")).toBeNull();
  });
});
