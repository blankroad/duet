import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CopyPlan, EntryRef, TaskEvent } from "@/types/bindings";
import { applyShelfTo } from "@/lib/fileActions";
import { useShelf } from "@/stores/shelf";
import { usePanes } from "@/stores/panes";
import { useAppSettings } from "@/stores/settings";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";
import { useNotices } from "@/stores/notices";

const cmd = vi.hoisted(() => ({
  fsCopyPlan: vi.fn(),
  fsCopyExecute: vi.fn(),
  tasksList: vi.fn(),
  listen: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: cmd,
  events: { taskEvent: { listen: cmd.listen } },
}));

beforeEach(() => {
  vi.useFakeTimers();
  cmd.fsCopyPlan.mockReset();
  cmd.tasksList.mockReset().mockResolvedValue({ status: "ok", data: [] });
  cmd.listen.mockReset().mockResolvedValue(() => {});
  cmd.fsCopyExecute
    .mockReset()
    .mockResolvedValue({ status: "ok", data: "completed-copy" });
  useShelf.getState().clear();
  usePanes.getState().setActivePane("left");
  usePanes
    .getState()
    .setEntries("left", { source: { kind: "local" }, path: "/dst" }, []);
  useAppSettings.getState().setConfirmTransfer("never");
  cmd.fsCopyPlan.mockImplementation(
    async (items: EntryRef[], dst: CopyPlan["dst"]) => ({
      status: "ok",
      data: {
        src_source: items[0]!.location.source,
        dst,
        items,
        conflicts: [],
        total_size_bytes: 0,
        strategy: { kind: "local_to_local" },
      } satisfies CopyPlan,
    }),
  );
});

afterEach(() => {
  cleanup();
  useShelf.getState().clear();
  useTasks.getState().setAll([]);
  useToast.getState().clear();
  useNotices.getState().clear();
  useAppSettings.getState().setConfirmTransfer("conflicts_only");
  vi.clearAllTimers();
  vi.useRealTimers();
});

function emit(change: TaskEvent["change"]) {
  const listener = cmd.listen.mock.calls[0]![0] as (event: {
    payload: TaskEvent;
  }) => void;
  listener({ payload: { task_id: "completed-copy", change } });
}

function enqueue(kind: "copy" | "delete") {
  emit({
    kind: "enqueued",
    task: {
      id: "completed-copy",
      kind,
      title: `${kind} item(s)`,
      status: { kind: "running" },
      host_key: { kind: "local" },
      progress: null,
      error_message: null,
      affected_locations: [],
    },
  });
}

describe("shell-settings-06: 첫 그룹 실행 완료 이벤트 뒤 재적용", () => {
  it.fails(
    "shell-settings-06: 첫 그룹의 복사 실행이 성공하면 다음 소스를 처리한다",
    async () => {
      renderHook(() => useTaskEvents());
      await act(async () => {});
      useShelf.getState().add([
        {
          location: { source: { kind: "local" }, path: "/src" },
          name: "a.txt",
        },
        {
          location: {
            source: {
              kind: "ssh",
              connection_id: "prod:review",
              host_ip: "127.0.0.1",
              user: "u",
            },
            path: "/srv",
          },
          name: "b.txt",
        },
      ]);
      await applyShelfTo("copy", vi.fn(), vi.fn());
      expect(cmd.fsCopyExecute).toHaveBeenCalledTimes(1);
      act(() => {
        enqueue("copy");
        emit({ kind: "completed", journal_id: "review-journal" });
      });
      await applyShelfTo("copy", vi.fn(), vi.fn());
      const second = cmd.fsCopyPlan.mock.calls[1]![0] as EntryRef[];
      expect(second[0]!.location.source.kind).toBe("ssh");
    },
  );
});

describe("shell-settings-04: 백그라운드 실패 기록은 원문을 보존하는 대조군", () => {
  for (const kind of ["copy", "delete"] as const) {
    it(`${kind} 작업 실패 이벤트의 경로는 알림 자세히에 남는다`, async () => {
      renderHook(() => useTaskEvents());
      await act(async () => {});
      act(() => {
        enqueue(kind);
        emit({
          kind: "failed",
          message: "분기보고서.xlsx: permission denied",
          error: {
            kind: "PermissionDenied",
            message: "/srv/data/분기보고서.xlsx",
          },
        });
      });
      expect(useNotices.getState().items[0]!.detail).toContain(
        "분기보고서.xlsx",
      );
    });
  }
});
