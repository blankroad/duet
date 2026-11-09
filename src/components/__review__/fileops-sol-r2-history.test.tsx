import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import type { JournalEntry } from "@/types/bindings";
import i18n from "@/i18n";
import { useJournal } from "@/stores/journal";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";

const fixture = vi.hoisted(() => ({ history: [] as JournalEntry[] }));
vi.mock("@/lib/fileActions", () => ({ triggerUndo: vi.fn(), triggerRedo: vi.fn() }));
vi.mock("@/types/bindings", () => ({
  commands: { undoHistory: () => Promise.resolve({ status: "ok", data: fixture.history }) },
  events: { journalChangedEvent: { listen: () => Promise.resolve(() => {}) } },
}));
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { HistoryDialog } from "@/components/dialogs/HistoryDialog";

function entry(name: string, undone = false): JournalEntry {
  const source = { kind: "local" as const };
  return {
    id: name, timestamp: "2026-11-08T10:00:00Z", undone,
    op: { kind: "mkdir", source, path: `/fixture/${name}` },
    undo: { kind: "undo_mkdir", source, path: `/fixture/${name}` },
  };
}
beforeEach(async () => {
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
