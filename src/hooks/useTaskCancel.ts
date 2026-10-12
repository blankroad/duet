import { useTasks } from "@/stores/tasks";
import { useToast } from "@/stores/toast";
import { commands } from "@/types/bindings";
import { formatErr } from "@/lib/error";

/** Shared cancellation state survives moving a task into the background. */
export function useTaskCancel(id: string) {
  const cancelling = useTasks((s) => s.cancelling.has(id));
  const cancel = async () => {
    const state = useTasks.getState();
    if (!state.tasks.has(id) || state.cancelling.has(id)) return;
    state.setCancelling(id, true);
    try {
      const result = await commands.taskCancel(id);
      if (result.status === "error") throw result.error;
    } catch (e) {
      useTasks.getState().setCancelling(id, false);
      useToast.getState().show(formatErr(e), "error");
    }
  };
  return { cancelling, cancel };
}
