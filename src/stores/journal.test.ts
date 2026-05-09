import { describe, it, expect, beforeEach } from "vitest";
import { useJournal } from "./journal";
import type { JournalEntry } from "@/types/bindings";

const mk = (id: string, undone = false): JournalEntry =>
  ({
    id,
    timestamp: new Date().toISOString(),
    op: { kind: "mkdir", path: "/x", source: { kind: "local" } },
    undo: { kind: "irreversible" },
    undone,
  }) as unknown as JournalEntry;

describe("journal store", () => {
  beforeEach(() => useJournal.setState({ entries: [], hasUndoable: false }));

  it("pushed sets hasUndoable", () => {
    useJournal.getState().pushed(mk("1"));
    expect(useJournal.getState().hasUndoable).toBe(true);
  });

  it("markUndone clears hasUndoable when all undone", () => {
    useJournal.getState().pushed(mk("1"));
    useJournal.getState().markUndone("1");
    expect(useJournal.getState().hasUndoable).toBe(false);
  });

  it("setHistory replaces and recomputes", () => {
    useJournal.getState().setHistory([mk("a", true), mk("b", false)]);
    expect(useJournal.getState().hasUndoable).toBe(true);
  });
});
