import { describe, it, expect } from "vitest";
import { sameSource, sameLocation, childLocation } from "./entryDnd";
import type { Location, SourceId } from "@/types/bindings";

const local: SourceId = { kind: "local" };
const ssh1: SourceId = { kind: "ssh", connection_id: "c1", host_ip: "10.0.0.1", user: "me" };
const ssh2: SourceId = { kind: "ssh", connection_id: "c2", host_ip: "10.0.0.2", user: "me" };

describe("entryDnd — sameSource", () => {
  it("two locals match", () => expect(sameSource(local, local)).toBe(true));
  it("same ssh connection matches", () => expect(sameSource(ssh1, { ...ssh1 })).toBe(true));
  it("different ssh connection differs", () => expect(sameSource(ssh1, ssh2)).toBe(false));
  it("local vs ssh differ", () => expect(sameSource(local, ssh1)).toBe(false));
});

describe("entryDnd — sameLocation", () => {
  const a: Location = { source: local, path: "/home/x" };
  it("same source + path", () => expect(sameLocation(a, { source: local, path: "/home/x" })).toBe(true));
  it("different path", () => expect(sameLocation(a, { source: local, path: "/home/y" })).toBe(false));
  it("different source", () => expect(sameLocation(a, { source: ssh1, path: "/home/x" })).toBe(false));
});

describe("entryDnd — childLocation", () => {
  it("joins with separator", () => {
    expect(childLocation({ source: local, path: "/home/x" }, "docs")).toEqual({
      source: local,
      path: "/home/x/docs",
    });
  });
  it("avoids double slash at root", () => {
    expect(childLocation({ source: local, path: "/" }, "docs").path).toBe("/docs");
  });
});
