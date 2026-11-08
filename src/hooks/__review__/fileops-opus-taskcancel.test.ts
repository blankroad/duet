// fileops 점검(2026-11-08, opus) 재현 — 실행 중 작업 취소 시 이벤트 이중 수신.
//
// 백엔드 `TaskQueue::cancel` 은 실행 중인 작업에도 **즉시** `Cancelled` 를 emit 하고
// (services/task_queue.rs `cancel`), 작업 본체가 실제로 멈춘 뒤 worker 가 `finalize` 로
// 또 한 번 종결 이벤트(Cancelled / Completed / Failed)를 emit 한다. 아래는 그 순서를
// 그대로 흘려 넣고 사용자에게 보이는 토스트를 본다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";
import type { TaskDto, TaskEvent } from "@/types/bindings";

const h = vi.hoisted(() => ({
  emit: null as null | ((e: { payload: TaskEvent }) => void),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    tasksList: () => Promise.resolve({ status: "ok", data: [] }),
  },
  events: {
    taskEvent: {
      listen: (cb: (e: { payload: TaskEvent }) => void) => {
        h.emit = cb;
        return Promise.resolve(() => {});
      },
    },
  },
}));

import { useTaskEvents } from "../useTaskEvents";

const task = (id: string): TaskDto =>
  ({
    id,
    kind: "delete",
    status: { kind: "queued" },
    title: "Moving 40 item(s) to trash",
    host_key: { kind: "local" },
    progress: null,
    error_message: null,
    affected_locations: [],
  }) as unknown as TaskDto;

const send = (task_id: string, change: unknown) =>
  act(() => h.emit!({ payload: { task_id, change } as TaskEvent }));

const messages = () => useToast.getState().toasts.map((t) => t.message);

afterEach(() => {
  useTasks.setState({ tasks: new Map(), cancelling: new Set() });
  useToast.setState({ toasts: [] });
});

describe("fileops-opus: 실행 중 작업 취소", () => {
  it.fails("fileops-16: 취소 1번에 '취소됨' 토스트가 두 번 뜨지 않는다 (cancel() emit + finalize emit)", async () => {
    renderHook(() => useTaskEvents());
    await act(async () => {});
    send("t1", { kind: "enqueued", task: task("t1") });
    send("t1", { kind: "started" });
    // 사용자가 [취소] — TaskQueue::cancel 이 즉시 emit
    send("t1", { kind: "cancelled" });
    // 작업 본체가 다음 확인 지점에서 멈춤 — worker finalize 가 또 emit
    send("t1", { kind: "cancelled" });
    const cancelToasts = messages().filter((m) => /cancel/i.test(m));
    expect(cancelToasts, JSON.stringify(messages())).toHaveLength(1);
  });

  it.fails("fileops-16: '취소됨'을 보여 준 작업이 그 뒤 '완료'로 보고되지 않는다 (확인 지점을 이미 지난 경우)", async () => {
    renderHook(() => useTaskEvents());
    await act(async () => {});
    send("t2", { kind: "enqueued", task: task("t2") });
    send("t2", { kind: "started" });
    send("t2", { kind: "cancelled" });
    // 마지막 확인 지점을 이미 지나 작업이 끝까지 감 → finalize(Completed)
    send("t2", {
      kind: "completed",
      journal_id: "00000000-0000-0000-0000-000000000000",
    });
    const all = messages();
    const saidCancelled = all.some((m) => /cancel/i.test(m));
    const saidDone = all.some((m) => /complete/i.test(m));
    expect(saidCancelled && saidDone, JSON.stringify(all)).toBe(false);
  });
});
