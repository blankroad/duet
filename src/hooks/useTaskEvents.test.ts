import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useTasks } from "@/stores/tasks";
import type { TaskDto, TaskEvent } from "@/types/bindings";

// 이벤트 핸들러와 스냅샷 응답을 테스트가 직접 쥔다 — 순서를 마음대로 뒤섞는다.
const h = vi.hoisted(() => ({
  emit: null as null | ((e: { payload: TaskEvent }) => void),
  resolveList: null as null | ((r: unknown) => void),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@/types/bindings", () => ({
  commands: {
    tasksList: () =>
      new Promise((resolve) => {
        h.resolveList = resolve;
      }),
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

import { useTaskEvents } from "./useTaskEvents";

const mk = (id: string): TaskDto =>
  ({
    id,
    kind: "copy",
    status: { kind: "running" },
    title: id,
    host_key: { kind: "local" },
    progress: null,
    error_message: null,
    affected_locations: [],
  }) as unknown as TaskDto;

const flush = () => act(async () => {});

afterEach(() => useTasks.setState({ tasks: new Map(), cancelling: new Set() }));

describe("useTaskEvents — 초기 스냅샷과 이벤트 순서", () => {
  it("스냅샷보다 먼저 들어온 새 작업이 늦게 온 빈 스냅샷에 지워지지 않는다", async () => {
    renderHook(() => useTaskEvents());
    await flush();
    act(() =>
      h.emit!({
        payload: {
          task_id: "new",
          change: { kind: "enqueued", task: mk("new") },
        } as TaskEvent,
      }),
    );
    await act(async () => h.resolveList!({ status: "ok", data: [] }));
    expect(useTasks.getState().tasks.has("new")).toBe(true);
  });

  it("스냅샷 전에 끝난 작업이 스냅샷으로 되살아나지 않는다", async () => {
    renderHook(() => useTaskEvents());
    await flush();
    act(() =>
      h.emit!({
        payload: {
          task_id: "old",
          change: { kind: "cancelled" },
        } as TaskEvent,
      }),
    );
    await act(async () => h.resolveList!({ status: "ok", data: [mk("old")] }));
    expect(useTasks.getState().tasks.has("old")).toBe(false);
  });

  it("스냅샷 전에 온 시작·진행이 옛 스냅샷(대기·낮은 진행률)에 덮이지 않는다", async () => {
    renderHook(() => useTaskEvents());
    await flush();
    act(() => {
      h.emit!({
        payload: { task_id: "x", change: { kind: "started" } } as TaskEvent,
      });
      h.emit!({
        payload: {
          task_id: "x",
          change: { kind: "progress", progress: { percent: 80 } },
        } as unknown as TaskEvent,
      });
    });
    const stale = {
      ...mk("x"),
      status: { kind: "queued" },
      progress: { percent: 10 },
    } as unknown as TaskDto;
    await act(async () => h.resolveList!({ status: "ok", data: [stale] }));
    const t = useTasks.getState().tasks.get("x");
    expect(t?.status.kind).toBe("running");
    expect(t?.progress?.percent).toBe(80);
  });
});
