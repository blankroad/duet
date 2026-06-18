import { describe, it, expect } from "vitest";
import {
  sameSource,
  sameLocation,
  childLocation,
  parentPath,
  dropDestination,
  normalizePath,
} from "./entryDnd";
import type { Location, SourceId } from "@/types/bindings";

const local: SourceId = { kind: "local" };
const ssh1: SourceId = {
  kind: "ssh",
  connection_id: "c1",
  host_ip: "10.0.0.1",
  user: "me",
};
const ssh2: SourceId = {
  kind: "ssh",
  connection_id: "c2",
  host_ip: "10.0.0.2",
  user: "me",
};

describe("entryDnd — sameSource", () => {
  it("two locals match", () => expect(sameSource(local, local)).toBe(true));
  it("same ssh connection matches", () =>
    expect(sameSource(ssh1, { ...ssh1 })).toBe(true));
  it("different ssh connection differs", () =>
    expect(sameSource(ssh1, ssh2)).toBe(false));
  it("local vs ssh differ", () => expect(sameSource(local, ssh1)).toBe(false));
});

describe("entryDnd — sameLocation", () => {
  const a: Location = { source: local, path: "/home/x" };
  it("same source + path", () =>
    expect(sameLocation(a, { source: local, path: "/home/x" })).toBe(true));
  it("different path", () =>
    expect(sameLocation(a, { source: local, path: "/home/y" })).toBe(false));
  it("different source", () =>
    expect(sameLocation(a, { source: ssh1, path: "/home/x" })).toBe(false));
});

describe("entryDnd — childLocation", () => {
  it("joins with separator", () => {
    expect(childLocation({ source: local, path: "/home/x" }, "docs")).toEqual({
      source: local,
      path: "/home/x/docs",
    });
  });
  it("avoids double slash at root", () => {
    expect(childLocation({ source: local, path: "/" }, "docs").path).toBe(
      "/docs",
    );
  });
  it("uses backslash on Windows, no C:\\/ at drive root", () => {
    // 드라이브 루트 — C:\ + Users 가 C:\/Users(중복) 가 아니라 C:\Users 로.
    expect(childLocation({ source: local, path: "C:\\" }, "Users").path).toBe(
      "C:\\Users",
    );
    expect(
      childLocation({ source: local, path: "C:\\Users" }, "foo").path,
    ).toBe("C:\\Users\\foo");
  });
});

describe("entryDnd — parentPath", () => {
  it("POSIX", () => {
    expect(parentPath("/home/x/docs")).toBe("/home/x");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBeNull();
  });
  it("Windows drive paths", () => {
    expect(parentPath("C:\\Users\\foo")).toBe("C:\\Users");
    expect(parentPath("C:\\Users")).toBe("C:\\"); // 드라이브 루트로 보정
    expect(parentPath("C:\\")).toBeNull(); // 드라이브 루트엔 부모 없음
  });
  it("mixed separators", () => {
    expect(parentPath("C:\\Users/foo")).toBe("C:\\Users");
  });
});

describe("entryDnd — normalizePath", () => {
  it("cleans Windows mixed/doubled separators", () => {
    expect(normalizePath("C:\\/Users")).toBe("C:\\Users"); // 핵심: C:\/ → C:\
    expect(normalizePath("C:\\Users/foo")).toBe("C:\\Users\\foo");
    expect(normalizePath("C:\\Users\\")).toBe("C:\\Users"); // 끝 백슬래시 제거
    expect(normalizePath("C:\\")).toBe("C:\\"); // 드라이브 루트는 유지
    expect(normalizePath("\\\\server\\share")).toBe("\\\\server\\share"); // UNC 보존
  });
  it("cleans POSIX doubled/trailing separators", () => {
    expect(normalizePath("/home//x/")).toBe("/home/x");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/home/x")).toBe("/home/x");
  });
});

describe("entryDnd — dropDestination", () => {
  const base: Location = { source: local, path: "/home/x/sub" };
  it("'..' resolves to parent", () => {
    expect(dropDestination(base, "..").path).toBe("/home/x");
  });
  it("folder name resolves to child", () => {
    expect(dropDestination(base, "docs").path).toBe("/home/x/sub/docs");
  });
  it("null resolves to base", () => {
    expect(dropDestination(base, null)).toEqual(base);
  });
});
