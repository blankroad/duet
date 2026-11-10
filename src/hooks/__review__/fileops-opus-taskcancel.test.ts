// fileops 점검(2026-11-08, opus) 재현 → fileops-16 회귀 테스트. mocked FE test.
//
// 예전 백엔드 `TaskQueue::cancel` 은 실행 중인 작업에도 **즉시** `Cancelled` 를 emit 했고,
// 작업 본체가 실제로 멈춘 뒤 worker 가 `finalize` 로 또 종결 이벤트(Cancelled / Completed /
// Failed)를 냈다 → "취소됨" 토스트 두 번, 또는 "취소됨" 뒤에 "완료".
//
// 지금 계약(services/task_queue.rs, Rust 단위 테스트가 이벤트 횟수·순서를 확인):
// - 실행 중 취소 → 백엔드는 token 만 취소하고 아무 이벤트도 내지 않는다. 프론트는
//   `useTaskCancel` 이 "멈추는 중" 표시를 켜고 작업을 목록에 남긴다.
// - 작업이 실제로 끝나면 종결 이벤트가 **한 번** 온다 — Cancelled, 또는 마지막 확인 지점을
//   지났으면 Completed/Failed. 그 이벤트로 작업이 사라지고 "멈추는 중" 표시도 풀린다.
// 아래는 그 순서를 흘려 넣고 사용자에게 보이는 상태와 토스트를 본다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";
import type { TaskDto, TaskEvent } from "@/types/bindings";

const h = vi.hoisted(() => ({
  emit: null as null | ((e: { payload: TaskEvent }) => void),
  cancelCalls: 0,
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    tasksList: () => Promise.resolve({ status: "ok", data: [] }),
    // 실행 중 취소 — 새 백엔드는 이벤트를 내지 않는다.
    taskCancel: () => {
      h.cancelCalls += 1;
      return Promise.resolve({ status: "ok", data: null });
    },
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
import { useTaskCancel } from "../useTaskCancel";

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

/** 작업을 시작시키고 [취소] 를 두 번 누른다. */
async function startAndCancel(id: string) {
  renderHook(() => useTaskEvents());
  await act(async () => {});
  send(id, { kind: "enqueued", task: task(id) });
  send(id, { kind: "started" });
  const { result } = renderHook(() => useTaskCancel(id));
  await act(async () => {
    await result.current.cancel();
  });
  await act(async () => {
    await result.current.cancel();
  });
  return result;
}

afterEach(() => {
  h.cancelCalls = 0;
  useTasks.setState({ tasks: new Map(), cancelling: new Set() });
  useToast.setState({ toasts: [] });
});

describe("fileops-opus: 실행 중 작업 취소", () => {
  it("fileops-16: 취소하면 '멈추는 중'으로 남고, 실제로 멈춘 뒤 '취소됨' 토스트가 한 번 뜬다", async () => {
    const cancel = await startAndCancel("t1");
    // 두 번 눌러도 요청은 한 번.
    expect(h.cancelCalls).toBe(1);
    // 아직 멈추지 않았다 — 목록에 남고, 멈추는 중 표시, 토스트 없음.
    expect(useTasks.getState().tasks.has("t1")).toBe(true);
    expect(cancel.current.cancelling).toBe(true);
    expect(messages()).toEqual([]);
    // 작업 본체가 다음 확인 지점에서 멈춤 — worker finalize 가 한 번 emit.
    send("t1", { kind: "cancelled" });
    const cancelToasts = messages().filter((m) => /cancel/i.test(m));
    expect(cancelToasts, JSON.stringify(messages())).toHaveLength(1);
    expect(useTasks.getState().tasks.has("t1")).toBe(false);
    expect(useTasks.getState().cancelling.has("t1")).toBe(false);
  });

  it("fileops-16: 마지막 확인 지점을 이미 지나 끝까지 간 작업은 '취소됨'을 보이지 않는다", async () => {
    await startAndCancel("t2");
    // 끝까지 감 → finalize(Completed) 한 번.
    send("t2", {
      kind: "completed",
      journal_id: "00000000-0000-0000-0000-000000000000",
    });
    const all = messages();
    expect(
      all.some((m) => /cancel/i.test(m)),
      JSON.stringify(all),
    ).toBe(false);
    expect(useTasks.getState().tasks.has("t2")).toBe(false);
    expect(useTasks.getState().cancelling.has("t2")).toBe(false);
  });

  it("fileops-16: 취소 요청 뒤 실패로 끝나면 실패만 알린다", async () => {
    await startAndCancel("t3");
    send("t3", {
      kind: "failed",
      message: "io: disk",
      error: { kind: "Io", message: "disk" },
    });
    const all = messages();
    expect(
      all.some((m) => /cancel/i.test(m)),
      JSON.stringify(all),
    ).toBe(false);
    expect(all).toHaveLength(1);
    expect(useTasks.getState().cancelling.has("t3")).toBe(false);
  });
});
