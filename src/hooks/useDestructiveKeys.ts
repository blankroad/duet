import { useEffect } from "react";
import { commands } from "@/types/bindings";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import {
  resolveActiveTargets,
  triggerCopy,
  triggerDelete,
  triggerMove,
  triggerMkdir,
  triggerRename,
} from "@/lib/fileActions";

/**
 * F2/F5/F6/F7/Delete/Shift+Delete/Ctrl+Z 처리.
 * 활성 패널의 선택(set) 또는 cursor 위 단일 항목 대상.
 *
 * 트리거 로직은 lib/fileActions 로 추출 — 툴바(PaneToolbar)와 동일 경로.
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

      const { targets } = resolveActiveTargets();

      // F2 — 단일 선택만 rename
      if (e.key === "F2" && targets.length === 1) {
        e.preventDefault();
        triggerRename(open, showToast);
        return;
      }

      // F7 — new folder (parent = active pane current dir)
      if (e.key === "F7") {
        e.preventDefault();
        triggerMkdir(open);
        return;
      }

      // F5 — copy → 반대 패널
      if (e.key === "F5" && targets.length > 0) {
        e.preventDefault();
        await triggerCopy(open, showToast);
        return;
      }

      // F6 — move → 반대 패널
      if (e.key === "F6" && targets.length > 0) {
        e.preventDefault();
        await triggerMove(open, showToast);
        return;
      }

      // Delete — trash, Shift+Delete — permanent
      if (e.key === "Delete" && targets.length > 0) {
        e.preventDefault();
        await triggerDelete(e.shiftKey ? "permanent" : "trash", open, showToast);
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
