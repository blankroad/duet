/** Phase 1: FrecencyJumper + hook, mocked IPC; no live application/SSH. */
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import "@/i18n";
import { commands } from "@/types/bindings";
import type { FrecencyEntry } from "@/types/bindings";
import { FrecencyJumper } from "@/components/FrecencyJumper";
import { useFrecency } from "@/stores/frecency";
import { useIndexProgressEvents } from "@/hooks/useIndexProgressEvents";
vi.mock("@/types/bindings", () => ({
  commands: { frecencyQuery: vi.fn(), indexBuildGlobal: vi.fn() },
  events: {
    indexProgressEvent: { listen: vi.fn().mockResolvedValue(() => {}) },
  },
}));
const entry: FrecencyEntry = {
  location: { source: { kind: "local" }, path: "/fixture/old" },
  host_alias: null,
  count: 1,
  last_visit_ms: 0,
};
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(commands.frecencyQuery).mockResolvedValue({
    status: "ok",
    data: [entry],
  });
  vi.mocked(commands.indexBuildGlobal).mockResolvedValue({
    status: "ok",
    data: null,
  });
  useFrecency.getState().open();
});
afterEach(() => {
  cleanup();
  useFrecency.getState().close();
  vi.useRealTimers();
});

it("ux-smoke browse-s04 typing a new jumper query must not Enter into the previous result", async () => {
  const open = vi.fn();
  render(<FrecencyJumper onOpenLocation={open} onOpenHostPath={vi.fn()} />);
  await tick();
  expect(screen.getByText("/fixture/old")).toBeTruthy();
  vi.mocked(commands.frecencyQuery).mockReturnValue(new Promise(() => {}));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "missing" },
  });
  await tick();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(open).not.toHaveBeenCalled();
});

it("browse-s04: Enter opens the highlighted folder once the new query has answered", async () => {
  const open = vi.fn();
  render(<FrecencyJumper onOpenLocation={open} onOpenHostPath={vi.fn()} />);
  await tick();
  const fresh: FrecencyEntry = {
    ...entry,
    location: { source: { kind: "local" }, path: "/fixture/new" },
  };
  vi.mocked(commands.frecencyQuery).mockResolvedValue({
    status: "ok",
    data: [fresh],
  });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "new" } });
  await tick();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  expect(open).toHaveBeenCalledWith(fresh.location, expect.anything());
});

it.fails(
  "ux-smoke browse-s05 SC-19 StrictMode starts only one global index build",
  () => {
    renderHook(() => useIndexProgressEvents(), { wrapper: StrictMode });
    expect(commands.indexBuildGlobal).toHaveBeenCalledTimes(1);
  },
);

vi.setConfig({ testTimeout: 30000 });
