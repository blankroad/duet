import { describe, it, expect } from "vitest";
import { resolveHostLabel, aliasLabel } from "./hostLabel";
import type { SourceId } from "@/types/bindings";

const local: SourceId = { kind: "local" };
const ssh = (connId: string): SourceId => ({
  kind: "ssh",
  connection_id: connId,
  host_ip: "10.0.0.1",
  user: "deploy",
});

describe("resolveHostLabel", () => {
  it("local is always 'Local'", () => {
    expect(resolveHostLabel(local, {}, () => undefined)).toBe("Local");
  });

  it("uses nickname when set for the connection's alias", () => {
    const label = resolveHostLabel(ssh("c1"), { "prod-1": "Production" }, () => "prod-1");
    expect(label).toBe("Production");
  });

  it("falls back to alias when no nickname", () => {
    expect(resolveHostLabel(ssh("c1"), {}, () => "prod-1")).toBe("prod-1");
  });

  it("falls back to user@host_ip when alias unknown", () => {
    expect(resolveHostLabel(ssh("c1"), {}, () => undefined)).toBe("deploy@10.0.0.1");
  });
});

describe("aliasLabel", () => {
  it("returns nickname or the alias itself", () => {
    expect(aliasLabel("prod-1", { "prod-1": "Production" })).toBe("Production");
    expect(aliasLabel("prod-1", {})).toBe("prod-1");
  });
});
