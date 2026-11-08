/**
 * review/remote (opus R2) — remote-04 의 빠른 재연결 경로(stores/reconnect.ts quickReconnect).
 * 저장 호스트 "box" 의 주소를 new.lan 으로 바꿔 저장한 뒤(vault 의 "box" 항목은 box.lan 비번 그대로),
 * new.lan 탭이 끊겨 배너 [재연결]을 누르면 vault alias "box" 가 함께 전송되는가.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConnections } from "@/stores/connections";
import { useSavedHosts } from "@/stores/savedHosts";
import { useVault } from "@/stores/vault";

const m = vi.hoisted(() => ({ connectionOpen: vi.fn(), connectionOpenAdhoc: vi.fn() }));
vi.mock("@/types/bindings", () => ({ commands: m }));

import { quickReconnect } from "@/stores/reconnect";

beforeEach(() => {
  m.connectionOpenAdhoc.mockReset();
  m.connectionOpenAdhoc.mockResolvedValue({ status: "error", error: { kind: "AuthFailed" } });
  useConnections.setState({ active: {}, hosts: [], reconnecting: {} });
  // 주소를 고쳐 저장한 뒤의 상태 — alias 는 그대로 "box", vault["box"] = box.lan 비번.
  useSavedHosts.setState({
    hosts: [{ alias: "box", host: "new.lan", port: 22, user: "u", key_path: null }],
  });
  useVault.setState({ exists: true, unlocked: true });
});

describe("remote-opus R2: remote-04 빠른 재연결 경로", () => {
  it.fails("remote-04: new.lan 탭의 배너 재연결이 box.lan 용 저장 비번(alias box)을 new.lan 으로 보내지 않아야 한다", async () => {
    await quickReconnect("u@new.lan:22");
    expect(m.connectionOpenAdhoc).toHaveBeenCalledTimes(1);
    const arg = m.connectionOpenAdhoc.mock.calls[0]![0];
    expect({ host: arg.host, savedPasswordAlias: arg.savedPasswordAlias }).toEqual({
      host: "new.lan",
      savedPasswordAlias: null,
    });
  });
});
