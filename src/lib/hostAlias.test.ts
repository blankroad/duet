import { describe, it, expect } from "vitest";
import type { SavedHost } from "@/types/bindings";
import {
  parseAdHocAlias,
  findSavedHostForAlias,
  prefillFromAlias,
} from "./hostAlias";

const mk = (alias: string, host: string, user = "u", port = 22): SavedHost => ({
  alias,
  host,
  port,
  user,
  key_path: null,
});

describe("parseAdHocAlias", () => {
  it("splits user@host:port", () => {
    expect(parseAdHocAlias("root@10.0.0.5:22")).toEqual({
      user: "root",
      host: "10.0.0.5",
      port: 22,
    });
    expect(parseAdHocAlias("u@srv.example.com:2222")?.port).toBe(2222);
  });

  it("keeps IPv6 host — port 는 마지막 : 기준", () => {
    expect(parseAdHocAlias("u@::1:22")).toEqual({
      user: "u",
      host: "::1",
      port: 22,
    });
  });

  it("rejects ssh-config style aliases and malformed input", () => {
    // ~/.ssh/config 의 alias 는 이 형식이 아님 — 파싱 대상 아님
    expect(parseAdHocAlias("my-dart-reader")).toBeNull();
    expect(parseAdHocAlias("u@host")).toBeNull(); // 포트 없음
    expect(parseAdHocAlias("@host:22")).toBeNull(); // user 없음
    expect(parseAdHocAlias("u@:22")).toBeNull(); // host 없음
    expect(parseAdHocAlias("u@host:port")).toBeNull(); // 포트가 숫자 아님
    expect(parseAdHocAlias("u@host:0")).toBeNull();
    expect(parseAdHocAlias("u@host:70000")).toBeNull();
  });
});

describe("findSavedHostForAlias", () => {
  const hosts = [mk("nas", "10.0.0.5"), mk("build", "build.example.com")];

  it("matches by alias first", () => {
    expect(findSavedHostForAlias("nas", hosts)?.host).toBe("10.0.0.5");
  });

  it("matches a saved host by user/host/port when alias was renamed", () => {
    // 즐겨찾기엔 연결 alias(user@host:port)가 저장되지만 저장 호스트는 "nas"
    expect(findSavedHostForAlias("u@10.0.0.5:22", hosts)?.alias).toBe("nas");
  });

  it("returns undefined when nothing matches", () => {
    expect(findSavedHostForAlias("u@10.0.0.9:22", hosts)).toBeUndefined();
    expect(findSavedHostForAlias("unknown", hosts)).toBeUndefined();
  });
});

describe("prefillFromAlias", () => {
  it("builds a dialog prefill from an ad-hoc alias", () => {
    expect(prefillFromAlias("root@10.0.0.5:2222")).toEqual({
      alias: "root@10.0.0.5:2222",
      host: "10.0.0.5",
      port: 2222,
      user: "root",
      key_path: null,
    });
  });

  it("returns null for non ad-hoc aliases", () => {
    expect(prefillFromAlias("my-dart-reader")).toBeNull();
  });
});
