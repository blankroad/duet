import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { JournalEntry, JournalChangedEvent } from "@/types/bindings";
import i18n from "@/i18n";
import { useJournal } from "@/stores/journal";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";

const fixture = vi.hoisted(() => ({
  history: [] as JournalEntry[],
  onChange: undefined as
    | ((event: { payload: JournalChangedEvent }) => void)
    | undefined,
}));
vi.mock("@/lib/fileActions", () => ({
  triggerUndo: vi.fn(),
  triggerRedo: vi.fn(),
}));
vi.mock("@/types/bindings", () => ({
  commands: {
    undoHistory: () => Promise.resolve({ status: "ok", data: fixture.history }),
  },
  events: {
    journalChangedEvent: {
      listen: (callback: (event: { payload: JournalChangedEvent }) => void) => {
        fixture.onChange = callback;
        return Promise.resolve(() => {});
      },
    },
  },
}));
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { HistoryDialog } from "@/components/dialogs/HistoryDialog";

function entry(name: string, undone = false): JournalEntry {
  const source = { kind: "local" as const };
  return {
    id: name,
    timestamp: "2026-11-08T10:00:00Z",
    undone,
    stale: false,
    op: { kind: "mkdir", source, path: `/fixture/${name}` },
    undo: { kind: "undo_mkdir", source, path: `/fixture/${name}` },
  };
}
beforeEach(async () => {
  fixture.history = [];
  fixture.onChange = undefined;
  await i18n.changeLanguage("en");
  useKeymap.getState().setAll([]);
  useCommands.getState().setBuiltins([]);
  useJournal.setState({ entries: [], hasUndoable: false, hasRedoable: false });
});
afterEach(cleanup);
it("fileops-20: next-undo badge targets newest actionable entry after bootstrap", async () => {
  fixture.history = [entry("newest"), entry("oldest")];
  renderHook(() => useJournalEvents());
  await act(async () => {});
  render(<HistoryDialog onClose={() => {}} />);
  const badgeRow = screen.getByText("Next undo").closest("li");
  expect(badgeRow?.textContent).toContain("newest");
});
it("fileops-20: latest undone mkdir remains redoable after bootstrap", async () => {
  fixture.history = [entry("newest", true), entry("oldest")];
  renderHook(() => useJournalEvents());
  await act(async () => {});
  expect(useJournal.getState().hasRedoable).toBe(true);
});

it("U-11: stale rows are labeled skipped and the next undo targets the preceding operation", async () => {
  for (const language of ["en", "ko"]) {
    await i18n.changeLanguage(language);
    useJournal
      .getState()
      .setHistory([entry("active"), { ...entry("stale"), stale: true }]);
    render(<HistoryDialog onClose={() => {}} />);
    expect(
      screen
        .getByText(language === "en" ? "Next undo" : "다음 되돌리기")
        .closest("li")?.textContent,
    ).toContain("active");
    const staleRow = screen
      .getByText(language === "en" ? "Skipped" : "건너뜀")
      .closest("li");
    expect(staleRow?.textContent).toContain("stale");
    expect(staleRow?.className).not.toContain("line-through");
    cleanup();
  }
});

it("U-11: stale entries alone cannot be undone or redone", () => {
  useJournal.getState().setHistory([{ ...entry("stale", true), stale: true }]);
  expect(useJournal.getState().hasUndoable).toBe(false);
  expect(useJournal.getState().hasRedoable).toBe(false);
  useJournal.getState().setHistory([{ ...entry("stale"), stale: true }]);
  expect(useJournal.getState().hasUndoable).toBe(false);
});

it("U-11: redo looks past stale tails but stops at the first active operation", () => {
  const old = entry("old", true);
  const stale = { ...entry("stale"), stale: true };
  useJournal.getState().setHistory([old, stale]);
  expect(useJournal.getState().hasRedoable).toBe(true);
  useJournal.getState().setHistory([old, entry("active"), stale]);
  expect(useJournal.getState().hasRedoable).toBe(false);
});

it("U-11: live stale events update stack availability and survive later push/undo/redo events", async () => {
  const current = entry("current");
  fixture.history = [current];
  renderHook(() => useJournalEvents());
  await act(async () => {});
  expect(fixture.onChange).toBeTypeOf("function");
  act(() =>
    fixture.onChange?.({
      payload: { change: "stale", entry: { ...current, stale: true } },
    }),
  );
  expect(useJournal.getState().entries[0]?.stale).toBe(true);
  expect(useJournal.getState().hasUndoable).toBe(false);
  act(() =>
    fixture.onChange?.({ payload: { change: "push", entry: entry("next") } }),
  );
  expect(useJournal.getState().hasUndoable).toBe(true);
  act(() =>
    fixture.onChange?.({
      payload: { change: "undone", entry: entry("next", true) },
    }),
  );
  expect(useJournal.getState().hasUndoable).toBe(false);
  expect(useJournal.getState().hasRedoable).toBe(true);
  act(() =>
    fixture.onChange?.({ payload: { change: "redone", entry: entry("next") } }),
  );
  expect(useJournal.getState().hasUndoable).toBe(true);
  expect(useJournal.getState().hasRedoable).toBe(false);
});
