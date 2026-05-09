import { useEffect } from "react";
import { commands } from "@/types/bindings";
import type { EntryRef, DeleteMode, Location } from "@/types/bindings";
import { usePanes, type PaneId } from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

/**
 * F2/F5/F6/F7/Delete/Shift+Delete/Ctrl+Z 처리.
 * 활성 패널의 선택(set) 또는 cursor 위 단일 항목 대상.
 *
 * Plan 호출까지만 — execute 는 App.tsx 의 dialog 핸들러가 진행.
 * Ctrl+Z 는 직접 undoLast 호출 + toast (다이얼로그 없음).
 */
export function useDestructiveKeys() {
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable=true]")) return;

      const state = usePanes.getState();
      const active: PaneId = state.activePane;
      const pane = state.panes[active];
      const opposite: PaneId = active === "left" ? "right" : "left";

      const cursorEntry = pane.entries[pane.cursorIndex];
      const selectedNames =
        pane.selected.size > 0
          ? Array.from(pane.selected)
          : cursorEntry
            ? [cursorEntry.name]
            : [];
      const targets: EntryRef[] = selectedNames.map((name) => ({
        location: pane.location,
        name,
      }));

      // F2 — 단일 선택만 rename
      if (e.key === "F2" && targets.length === 1) {
        e.preventDefault();
        open({ kind: "rename", target: targets[0]! });
        return;
      }

      // F7 — new folder (parent = active pane current dir)
      if (e.key === "F7") {
        e.preventDefault();
        open({ kind: "mkdir", parent: pane.location });
        return;
      }

      // F5 — copy → 반대 패널
      if (e.key === "F5" && targets.length > 0) {
        e.preventDefault();
        const dst: Location = state.panes[opposite].location;
        const r = await commands.fsCopyPlan(targets, dst);
        if (r.status === "ok") open({ kind: "copy-confirm", plan: r.data });
        else showToast(`Copy plan failed: ${formatErr(r.error)}`);
        return;
      }

      // F6 — move → 반대 패널
      if (e.key === "F6" && targets.length > 0) {
        e.preventDefault();
        const dst: Location = state.panes[opposite].location;
        const r = await commands.fsMovePlan(targets, dst);
        if (r.status === "ok") open({ kind: "move-confirm", plan: r.data });
        else showToast(`Move plan failed: ${formatErr(r.error)}`);
        return;
      }

      // Delete — trash, Shift+Delete — permanent
      if (e.key === "Delete" && targets.length > 0) {
        e.preventDefault();
        const mode: DeleteMode = e.shiftKey ? "permanent" : "trash";
        const r = await commands.fsDeletePlan(targets, mode);
        if (r.status === "ok") {
          open({
            kind: mode === "permanent" ? "delete-danger" : "delete-confirm",
            plan: r.data,
          });
        } else {
          showToast(`Delete plan failed: ${formatErr(r.error)}`);
        }
        return;
      }

      // Ctrl+Z (or Cmd+Z) — undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        const r = await commands.undoLast();
        if (r.status === "ok") {
          showToast(r.data.message ?? `Undone (${r.data.kind})`);
        } else {
          showToast(`Undo failed: ${formatErr(r.error)}`);
        }
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, showToast]);
}
