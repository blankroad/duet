import { create } from "zustand";
import type { TaskDto, ProgressInfo, TaskStatus } from "@/types/bindings";

interface State {
  tasks: Map<string, TaskDto>;
  cancelling: Set<string>;
  setCancelling: (id: string, value: boolean) => void;
  add: (t: TaskDto) => void;
  setStatus: (id: string, status: TaskStatus) => void;
  setProgress: (id: string, progress: ProgressInfo) => void;
  setError: (id: string, message: string) => void;
  remove: (id: string) => void;
  setAll: (ts: TaskDto[]) => void;
}

export const useTasks = create<State>((set) => ({
  tasks: new Map(),
  cancelling: new Set(),
  setCancelling: (id, value) =>
    set((s) => {
      const cancelling = new Set(s.cancelling);
      if (value) cancelling.add(id);
      else cancelling.delete(id);
      return { cancelling };
    }),
  add: (t) =>
    set((s) => {
      const next = new Map(s.tasks);
      next.set(t.id, t);
      return { tasks: next };
    }),
  setStatus: (id, status) =>
    set((s) => {
      const cur = s.tasks.get(id);
      if (!cur) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...cur, status });
      return { tasks: next };
    }),
  setProgress: (id, progress) =>
    set((s) => {
      const cur = s.tasks.get(id);
      if (!cur) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...cur, progress });
      return { tasks: next };
    }),
  setError: (id, message) =>
    set((s) => {
      const cur = s.tasks.get(id);
      if (!cur) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...cur, error_message: message });
      return { tasks: next };
    }),
  remove: (id) =>
    set((s) => {
      if (!s.tasks.has(id)) return s;
      const next = new Map(s.tasks);
      next.delete(id);
      const cancelling = new Set(s.cancelling);
      cancelling.delete(id);
      return { tasks: next, cancelling };
    }),
  setAll: (ts) =>
    set((s) => {
      const next = new Map<string, TaskDto>();
      for (const t of ts) next.set(t.id, t);
      return {
        tasks: next,
        cancelling: new Set([...s.cancelling].filter((id) => next.has(id))),
      };
    }),
}));

/** Active = queued | running. UI 가 사용. */
export function selectActive(map: Map<string, TaskDto>): TaskDto[] {
  return Array.from(map.values()).filter(
    (t) => t.status.kind === "queued" || t.status.kind === "running",
  );
}
