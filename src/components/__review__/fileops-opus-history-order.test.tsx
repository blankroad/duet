// fileops 점검(2026-11-08, opus) 재현 — 앱 재시작 후 작업 기록 순서가 뒤집힌다.
//
// 백엔드 `Journal::history(limit)` 는 `lock.iter().rev()` — **최신이 먼저**
// (src-tauri/src/services/journal.rs `history`). 그런데 `useJournalEvents` 부트스트랩은
// 그 배열을 그대로 `setHistory` 에 넣고, store 는 "최신이 마지막"(stores/journal.ts)으로
// 가정한다 → HistoryDialog 의 정렬·"다음 Ctrl+Z" 배지·hasRedoable 이 뒤집힌다.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import "@/i18n";
import { useJournal } from "@/stores/journal";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";
import type { JournalEntry } from "@/types/bindings";

const h = vi.hoisted(() => ({ history: [] as unknown[] }));
vi.mock("@/lib/fileActions", () => ({
  triggerUndo: vi.fn().mockResolvedValue(undefined),
  triggerRedo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/types/bindings", () => ({
  commands: {
    undoHistory: () => Promise.resolve({ status: "ok", data: h.history }),
  },
  events: {
    journalChangedEvent: { listen: () => Promise.resolve(() => {}) },
  },
}));

import { useJournalEvents } from "@/hooks/useJournalEvents";
import { HistoryDialog } from "@/components/dialogs/HistoryDialog";

const mkdir = (name: string, ts: string, undone = false): JournalEntry =>
  ({
    id: name,
    timestamp: ts,
    op: { kind: "mkdir", path: `/w/${name}`, source: { kind: "local" } },
    undo: { kind: "irreversible" },
    undone,
  }) as unknown as JournalEntry;

beforeEach(() => {
  useKeymap.getState().setAll([]);
  useCommands.getState().setBuiltins([]);
  useJournal.setState({ entries: [], hasUndoable: false, hasRedoable: false });
});
afterEach(cleanup);

describe("fileops-opus: 재시작 후 작업 기록", () => {
  it("fileops-20: '다음 되돌리기' 배지는 가장 최근 작업에 붙는다", async () => {
    // 백엔드 응답 모양 그대로: 최신(newest) 먼저.
    h.history = [
      mkdir("newest", "2026-11-08T10:03:00Z"),
      mkdir("middle", "2026-11-08T10:02:00Z"),
      mkdir("oldest", "2026-11-08T10:01:00Z"),
    ];
    renderHook(() => useJournalEvents());
    await act(async () => {});
    render(<HistoryDialog onClose={() => {}} />);
    const rows = screen.getAllByRole("listitem");
    // 맨 위 행 = 최신, 배지도 그 행.
    expect(rows[0]!.textContent).toContain("newest");
    const badgeRow = rows.find((r) =>
      /Next undo|next/.test(r.textContent ?? ""),
    );
    expect(badgeRow?.textContent).toContain("newest");
  });

  it("fileops-20: 마지막 작업을 되돌린 상태로 재시작하면 다시 실행(redo)이 가능해야 한다", async () => {
    h.history = [
      mkdir("newest", "2026-11-08T10:03:00Z", true), // 되돌린 상태
      mkdir("oldest", "2026-11-08T10:01:00Z"),
    ];
    renderHook(() => useJournalEvents());
    await act(async () => {});
    // 백엔드 peek_redoable 은 newest 를 돌려준다(꼬리가 undone).
    expect(useJournal.getState().hasRedoable).toBe(true);
  });
});
