import { expect, it } from "vitest";
import { archiveCrumbs, buildCrumbs } from "./pathCrumbs";

it("POSIX 경로는 / 로 조립한다", () => {
  expect(buildCrumbs("/home/u/docs", false)).toEqual([
    { label: "home", path: "/home" },
    { label: "u", path: "/home/u" },
    { label: "docs", path: "/home/u/docs" },
  ]);
});

it("Windows 드라이브 루트는 C:\\ 로 시작한다", () => {
  expect(buildCrumbs("C:\\Users\\test", true)).toEqual([
    { label: "C:", path: "C:\\" },
    { label: "Users", path: "C:\\Users" },
    { label: "test", path: "C:\\Users\\test" },
  ]);
});

it("UNC 경로는 \\\\server\\share 를 루트로 보존한다", () => {
  expect(buildCrumbs("\\\\server\\share\\dir\\sub", true)).toEqual([
    { label: "\\\\server\\share", path: "\\\\server\\share" },
    { label: "dir", path: "\\\\server\\share\\dir" },
    { label: "sub", path: "\\\\server\\share\\dir\\sub" },
  ]);
});

it("현재 폴더 조각은 받은 경로를 그대로 쓴다", () => {
  const crumbs = buildCrumbs("/tmp/a\\b", false);
  expect(crumbs.at(-1)?.path).toBe("/tmp/a\\b");
});

it("아카이브 내부 조각은 루트 아래로 같은 구분자로 이어 붙인다", () => {
  expect(
    archiveCrumbs("/tmp/x/a.zip.d/sub/dir", "/tmp/x/a.zip.d", false),
  ).toEqual([
    { label: "sub", path: "/tmp/x/a.zip.d/sub" },
    { label: "dir", path: "/tmp/x/a.zip.d/sub/dir" },
  ]);
  expect(
    archiveCrumbs("C:\\Temp\\a.zip.d\\sub\\dir", "C:\\Temp\\a.zip.d", true),
  ).toEqual([
    { label: "sub", path: "C:\\Temp\\a.zip.d\\sub" },
    { label: "dir", path: "C:\\Temp\\a.zip.d\\sub\\dir" },
  ]);
  expect(archiveCrumbs("/elsewhere", "/tmp/x/a.zip.d", false)).toEqual([]);
});

it("드라이브 루트만 있으면 C:\\ 를 유지한다", () => {
  expect(buildCrumbs("C:", true)).toEqual([{ label: "C:", path: "C:\\" }]);
  expect(buildCrumbs("\\\\srv\\share", true)).toEqual([
    { label: "\\\\srv\\share", path: "\\\\srv\\share" },
  ]);
});

it("긴 경로·슬래시 UNC 루트도 한 조각이다 (browse-10)", () => {
  expect(buildCrumbs("\\\\?\\C:\\", true)).toEqual([
    { label: "\\\\?\\C:", path: "\\\\?\\C:\\" },
  ]);
  expect(buildCrumbs("\\\\?\\UNC\\srv\\share\\dir", true)).toEqual([
    { label: "\\\\?\\UNC\\srv\\share", path: "\\\\?\\UNC\\srv\\share" },
    { label: "dir", path: "\\\\?\\UNC\\srv\\share\\dir" },
  ]);
  expect(buildCrumbs("//srv/share/dir", true)).toEqual([
    { label: "\\\\srv\\share", path: "\\\\srv\\share" },
    { label: "dir", path: "//srv/share/dir" },
  ]);
  // 원격(POSIX)은 Windows 규칙을 타지 않는다.
  expect(buildCrumbs("//srv/share", false)).toEqual([
    { label: "srv", path: "/srv" },
    { label: "share", path: "//srv/share" },
  ]);
});
