/**
 * remote review (lead) — ad-hoc alias `user@host:port` 를 **첫** `@` 로 자른다.
 * 사용자명에 `@` 가 들어가는 로그인(AD/SSSD 의 `first.last@corp.com`)은 host 가
 * `corp.com@srv` 처럼 깨져, 복원 탭의 [재연결]·즐겨찾기 재접속이 엉뚱한 주소로 간다.
 * host 에는 `@` 가 올 수 없으므로 **마지막** `@` 로 잘라야 한다.
 */
import { describe, it, expect } from "vitest";
import { parseAdHocAlias, prefillFromAlias } from "../hostAlias";

describe("remote-lead: ad-hoc alias with '@' in the user name", () => {
  it.fails("remote-30: splits user/host at the last '@'", () => {
    expect(parseAdHocAlias("first.last@corp.com@srv.lan:22")).toEqual({
      user: "first.last@corp.com",
      host: "srv.lan",
      port: 22,
    });
  });

  it.fails("remote-30: prefill for reconnect points at the real host", () => {
    expect(prefillFromAlias("a@b.com@10.0.0.5:2222")?.host).toBe("10.0.0.5");
  });

  it("control: plain user still parses", () => {
    expect(parseAdHocAlias("u@srv.lan:22")).toEqual({ user: "u", host: "srv.lan", port: 22 });
  });
});
