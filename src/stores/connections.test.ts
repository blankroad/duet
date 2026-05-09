import { describe, it, expect, beforeEach } from "vitest";
import { useConnections, type Host, type ActiveConnection } from "./connections";

const reset = () => {
  useConnections.setState({ hosts: [], active: {} });
};

const mkHost = (alias: string, hasJump = false): Host => ({
  alias,
  hostname: `${alias}.example.com`,
  port: 22,
  user: "u",
  has_proxy_jump: hasJump,
});

const mkActive = (
  id: string,
  alias: string,
  state: ActiveConnection["state"] = { kind: "connected" },
): ActiveConnection => ({
  id,
  alias,
  host_ip: "10.0.0.1",
  user: "u",
  state,
});

describe("connections store", () => {
  beforeEach(reset);

  it("setHosts replaces the host list", () => {
    useConnections.getState().setHosts([mkHost("a"), mkHost("b", true)]);
    const { hosts } = useConnections.getState();
    expect(hosts).toHaveLength(2);
    expect(hosts[1]?.has_proxy_jump).toBe(true);
  });

  it("upsertActive adds and overwrites by id", () => {
    useConnections.getState().upsertActive(mkActive("a:1", "a"));
    expect(Object.keys(useConnections.getState().active)).toHaveLength(1);
    // 같은 id, 다른 host_ip → 덮어쓰기
    useConnections.getState().upsertActive({ ...mkActive("a:1", "a"), host_ip: "10.0.0.99" });
    expect(useConnections.getState().active["a:1"]?.host_ip).toBe("10.0.0.99");
  });

  it("removeActive is idempotent for unknown ids", () => {
    useConnections.getState().upsertActive(mkActive("a:1", "a"));
    useConnections.getState().removeActive("nope");
    expect(useConnections.getState().active["a:1"]).toBeDefined();
    useConnections.getState().removeActive("a:1");
    expect(useConnections.getState().active["a:1"]).toBeUndefined();
  });

  it("setState updates only the matching id; no-op for unknown id", () => {
    useConnections.getState().upsertActive(mkActive("a:1", "a", { kind: "connecting" }));
    useConnections.getState().setState("a:1", { kind: "connected" });
    expect(useConnections.getState().active["a:1"]?.state.kind).toBe("connected");
    useConnections.getState().setState("missing", { kind: "error", message: "x" });
    // active 변화 없음 (no throw)
    expect(Object.keys(useConnections.getState().active)).toEqual(["a:1"]);
  });

  it("stateByAlias picks highest-priority state per alias", () => {
    // 같은 alias 'a' 로 두 연결: connected vs connecting → connected 우선
    useConnections.getState().upsertActive(mkActive("a:1", "a", { kind: "connecting" }));
    useConnections.getState().upsertActive(mkActive("a:2", "a", { kind: "connected" }));
    useConnections.getState().upsertActive(mkActive("b:1", "b", { kind: "error", message: "auth" }));
    const map = useConnections.getState().stateByAlias();
    expect(map["a"]?.kind).toBe("connected");
    expect(map["b"]?.kind).toBe("error");
  });

  it("stateByAlias returns empty for no active connections", () => {
    expect(useConnections.getState().stateByAlias()).toEqual({});
  });
});
