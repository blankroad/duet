import { describe, it, expect, beforeEach } from "vitest";
import { useTasks, selectActive } from "./tasks";
import type { TaskDto } from "@/types/bindings";

const mk = (
  id: string,
  status: TaskDto["status"] = { kind: "queued" },
): TaskDto =>
  ({
    id,
    kind: "copy",
    status,
    title: `task-${id}`,
    host_key: { kind: "local" },
    progress: null,
    error_message: null,
    affected_locations: [],
  }) as unknown as TaskDto;

describe("tasks store", () => {
  beforeEach(() => useTasks.setState({ tasks: new Map() }));

  it("add and remove", () => {
    useTasks.getState().add(mk("a"));
    expect(useTasks.getState().tasks.size).toBe(1);
    useTasks.getState().remove("a");
    expect(useTasks.getState().tasks.size).toBe(0);
  });

  it("setStatus updates only matching id", () => {
    useTasks.getState().add(mk("a"));
    useTasks.getState().setStatus("a", { kind: "running" });
    expect(useTasks.getState().tasks.get("a")?.status.kind).toBe("running");
    useTasks.getState().setStatus("missing", { kind: "running" });
    // no-op, no throw
  });

  it("setProgress updates only matching id", () => {
    useTasks.getState().add(mk("a"));
    useTasks.getState().setProgress("a", {
      bytes_done: 100,
      bytes_total: 200,
      speed_bps: 50,
      eta_sec: 2,
      percent: 50,
      current_file: "f.txt",
      files_done: 0,
      files_total: 1,
    });
    expect(useTasks.getState().tasks.get("a")?.progress?.percent).toBe(50);
  });

  it("selectActive filters queued+running", () => {
    useTasks.getState().add(mk("q", { kind: "queued" }));
    useTasks.getState().add(mk("r", { kind: "running" }));
    useTasks
      .getState()
      .add(mk("c", { kind: "completed", journal_id: "x" } as any));
    useTasks.getState().add(mk("f", { kind: "failed", message: "x" } as any));
    const active = selectActive(useTasks.getState().tasks);
    expect(active.length).toBe(2);
    expect(active.map((t) => t.id).sort()).toEqual(["q", "r"]);
  });

  it("setAll replaces map", () => {
    useTasks.getState().add(mk("a"));
    useTasks.getState().setAll([mk("b"), mk("c")]);
    expect(useTasks.getState().tasks.size).toBe(2);
    expect(useTasks.getState().tasks.has("a")).toBe(false);
  });

  it("mergeSnapshot keeps tasks that arrived by event before the snapshot", () => {
    useTasks.getState().add(mk("new", { kind: "running" }));
    useTasks.getState().mergeSnapshot([], new Set());
    expect(useTasks.getState().tasks.has("new")).toBe(true);
  });

  it("mergeSnapshot does not revive tasks that finished before the snapshot", () => {
    useTasks
      .getState()
      .mergeSnapshot([mk("old", { kind: "running" })], new Set(["old"]));
    expect(useTasks.getState().tasks.has("old")).toBe(false);
  });

  it("mergeSnapshot prefers the event-updated task over the stale snapshot copy", () => {
    useTasks.getState().add(mk("a", { kind: "running" }));
    useTasks.getState().mergeSnapshot([mk("a"), mk("b")], new Set());
    expect(useTasks.getState().tasks.get("a")?.status.kind).toBe("running");
    expect(useTasks.getState().tasks.has("b")).toBe(true);
  });
});
