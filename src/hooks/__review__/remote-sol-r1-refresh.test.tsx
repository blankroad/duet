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
  loadRemotePlaces: vi.fn(),
  evictRemotePlaces: vi.fn(),
}));

const loc = (connection_id: string) => ({
  source: {
    kind: "ssh" as const,
    connection_id,
    host_ip: "10.0.0.2",
    user: "u",
  },
  path: "/srv",
});
function emit(id: string, kind: "connected" | "connecting") {
  const listener = vi.mocked(events.connectionStateEvent.listen).mock
    .calls[0]![0];
  act(() =>
    listener({
      event: "connection-state-event",
      id: 1,
      payload: {
        id,
        alias: "nas",
        host_ip: "10.0.0.2",
        user: "u",
        state: { kind },
      },
    } as never),
  );
}
beforeEach(() => {
  useConnections.setState({ active: {} });
  const state = usePanes.getState();
  const tab = state.panes.left.tabs[0]!;
  usePanes.setState({
    panes: {
      left: {
        activeTabIndex: 0,
        tabs: [{ ...tab, id: "left-visible", location: loc("nas:one") }],
      },
      right: {
        activeTabIndex: 0,
        tabs: [
          { ...tab, id: "right-visible", location: loc("nas:one") },
          { ...tab, id: "right-hidden", location: loc("nas:hidden") },
        ],
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("remote-27 review: refresh both visible panes once, never hidden tabs or duplicate connected events", () => {
  const refresh = vi.fn();
  renderHook(() => useConnectionEvents(refresh));
  emit("nas:one", "connected");
  emit("nas:hidden", "connected");
  expect(refresh).not.toHaveBeenCalled();
  emit("nas:hidden", "connecting");
  emit("nas:hidden", "connected");
  expect(refresh).not.toHaveBeenCalled();
  emit("nas:one", "connecting");
  emit("nas:one", "connected");
  expect(refresh.mock.calls).toEqual([["left"], ["right"]]);
  emit("nas:one", "connected");
  expect(refresh).toHaveBeenCalledTimes(2);
});
