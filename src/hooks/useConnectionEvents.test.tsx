import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { events } from "@/types/bindings";
import { useConnectionEvents } from "@/hooks/useConnectionEvents";
import { useConnections } from "@/stores/connections";
import { usePanes } from "@/stores/panes";

vi.mock("@/types/bindings", () => ({
  events: {
    connectionStateEvent: { listen: vi.fn(() => Promise.resolve(vi.fn())) },
  },
}));
vi.mock("@/stores/places", () => ({
  loadRemotePlaces: vi.fn(() => Promise.resolve()),
  evictRemotePlaces: vi.fn(),
}));

const CONN = "nas:1111";
const sshLoc = (id: string) => ({
  source: {
    kind: "ssh" as const,
    connection_id: id,
    host_ip: "10.0.0.5",
    user: "u",
  },
  path: "/srv",
});

type Kind = "connected" | "connecting" | "error";
function emit(id: string, kind: Kind) {
  const listener = vi.mocked(events.connectionStateEvent.listen).mock
    .calls[0]![0];
  const state =
    kind === "error" ? { kind, message: "boom" } : ({ kind } as { kind: Kind });
  act(() => {
    listener({
      event: "connection-state-event",
      id: 1,
      payload: { id, alias: "nas", host_ip: "10.0.0.5", user: "u", state },
    } as never);
  });
}

beforeEach(() => {
  useConnections.setState({ active: {} });
  usePanes.getState().setEntries("left", sshLoc(CONN), []);
  usePanes
    .getState()
    .setEntries("right", { source: { kind: "local" }, path: "/tmp" }, []);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("remote-27: auto-reconnect success refreshes panes showing that connection", () => {
  const refresh = vi.fn();
  renderHook(() => useConnectionEvents(refresh));
  emit(CONN, "connected");
  expect(refresh).not.toHaveBeenCalled(); // 첫 연결은 새로고침 대상 아님

  emit(CONN, "connecting");
  emit(CONN, "connected");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(refresh).toHaveBeenCalledWith("left");
});

it("remote-27: recovery from error also refreshes, other connections do not", () => {
  const refresh = vi.fn();
  renderHook(() => useConnectionEvents(refresh));
  emit(CONN, "connected");
  emit("other:2222", "connected");
  emit("other:2222", "error");
  emit("other:2222", "connected");
  expect(refresh).not.toHaveBeenCalled();

  emit(CONN, "error");
  emit(CONN, "connected");
  expect(refresh).toHaveBeenCalledWith("left");
  expect(refresh).not.toHaveBeenCalledWith("right");
});
