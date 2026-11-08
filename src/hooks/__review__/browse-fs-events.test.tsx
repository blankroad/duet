import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { events } from "@/types/bindings";
import { useFsChangedEvents } from "@/hooks/useFsChangedEvents";
import { usePanes } from "@/stores/panes";

vi.mock("@/types/bindings", () => ({
  events: { fsChangedEvent: { listen: vi.fn(() => Promise.resolve(vi.fn())) } },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.fails(
  "browse-13 (F-sol-05): a thousand child events should coalesce into bounded folder refreshes",
  async () => {
    vi.useFakeTimers();
    usePanes
      .getState()
      .setEntries("left", { source: { kind: "local" }, path: "/watched" }, []);
    usePanes
      .getState()
      .setEntries(
        "right",
        { source: { kind: "local" }, path: "/unrelated" },
        [],
      );
    const refresh = vi.fn();
    renderHook(() => useFsChangedEvents(refresh));
    const listener = vi.mocked(events.fsChangedEvent.listen).mock.calls[0]![0];
    act(() => {
      for (let i = 0; i < 1000; i++) {
        listener({
          event: "fs-changed-event",
          id: 1,
          payload: { source: { kind: "local" }, path: `/watched/new-${i}` },
        });
      }
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(refresh.mock.calls.length).toBeLessThanOrEqual(2);
  },
);
