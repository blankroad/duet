import { describe, expect, it } from "vitest";
import type { Location, SourceId } from "@/types/bindings";
import { isSameOrInside } from "@/lib/nesting";

const local = (path: string): Location => ({ source: { kind: "local" }, path });
const ssh = (path: string, id = "c1"): Location => ({
  source: {
    kind: "ssh",
    connection_id: id,
    host_ip: "10.0.0.1",
    user: "u",
  } as SourceId,
  path,
});

describe("isSameOrInside (U-04 / browse-14 FE 안내)", () => {
  it("자기 자신과 하위 전체를 잡는다", () => {
    expect(isSameOrInside(local("/w/proj"), local("/w/proj"))).toBe(true);
    expect(isSameOrInside(local("/w/proj/sub"), local("/w/proj"))).toBe(true);
    expect(isSameOrInside(local("/w/proj/a/b/c"), local("/w/proj"))).toBe(true);
  });

  it("구분자 경계로 비교한다 — 이름이 앞부분만 같은 형제는 아니다", () => {
    expect(isSameOrInside(local("/w/project"), local("/w/proj"))).toBe(false);
    expect(isSameOrInside(local("/w"), local("/w/proj"))).toBe(false);
  });

  it("끝 구분자·중복 구분자를 무시한다", () => {
    expect(isSameOrInside(local("/w/proj/"), local("/w//proj"))).toBe(true);
  });

  it("Windows 로컬 표기 차이(구분자·대소문자)를 흡수한다", () => {
    expect(
      isSameOrInside(
        local("C:/Sandbox/Project/"),
        local("C:\\sandbox\\project"),
      ),
    ).toBe(true);
    expect(
      isSameOrInside(
        local("c:\\sandbox\\project\\deep"),
        local("C:\\Sandbox\\Project"),
      ),
    ).toBe(true);
    expect(isSameOrInside(local("C:\\x"), local("C:\\"))).toBe(true);
  });

  it("원격 이름의 `\\` 는 구분자가 아니다", () => {
    expect(isSameOrInside(ssh("/srv/a\\b"), ssh("/srv/a"))).toBe(false);
    expect(isSameOrInside(ssh("/srv/a/b"), ssh("/srv/a"))).toBe(true);
  });

  it("소스가 다르면 비교하지 않는다", () => {
    expect(isSameOrInside(ssh("/w/proj/sub"), local("/w/proj"))).toBe(false);
    expect(isSameOrInside(ssh("/w/proj/sub", "c2"), ssh("/w/proj"))).toBe(
      false,
    );
  });
});
