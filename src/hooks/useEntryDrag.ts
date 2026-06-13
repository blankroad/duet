import { useCallback } from "react";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import { exceedsThreshold } from "@/lib/marquee";
import { useDragState } from "@/stores/dragState";
import { childLocation, sameLocation } from "@/lib/entryDnd";
import { resolveDropAt } from "@/lib/dropTarget";
import { planTransferTo } from "@/lib/fileActions";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";

/**
 * 항목 행/셀의 포인터 기반 드래그 — 임계값을 넘으면 드래그 시작, mouseup 위치의
 * 패널/폴더로 드롭. 이동 기본 / Ctrl=복사, 항상 확인 다이얼로그 경유.
 *
 * HTML5 DnD 대신 포인터 이벤트만 사용 — Tauri dragDropEnabled(OS 드롭)와 충돌 없음,
 * SSH 소스 항목도 동일하게 동작. 드래그가 발생하면 뒤따르는 click(커서 이동) 은 억제.
 */
export function useEntryDrag(id: PaneId) {
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  return useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      if (e.button !== 0) return;
      const sx = e.clientX;
      const sy = e.clientY;
      const tab = activeTab(usePanes.getState(), id);
      const names =
        tab.selected.size > 0 && tab.selected.has(entry.name)
          ? Array.from(tab.selected)
          : [entry.name];
      let started = false;

      const onMove = (ev: MouseEvent) => {
        if (!started) {
          if (!exceedsThreshold(ev.clientX - sx, ev.clientY - sy)) return;
          started = true;
          useDragState.getState().start({
            source: tab.location,
            targets: names.map((name) => ({ location: tab.location, name })),
            label: names.length === 1 ? (names[0] ?? "") : `${names.length} items`,
            x: ev.clientX,
            y: ev.clientY,
          });
          document.body.style.cursor = "grabbing";
        }
        const d = resolveDropAt(ev.clientX, ev.clientY);
        useDragState.getState().move(ev.clientX, ev.clientY, d?.pane ?? null, d?.folder ?? null);
      };

      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        if (!started) return; // 단순 클릭 — 행의 onClick 이 처리
        document.body.style.cursor = "";
        const { source, targets } = useDragState.getState();
        const d = resolveDropAt(ev.clientX, ev.clientY);
        useDragState.getState().end();
        // 드래그 직후의 합성 click 1회 억제 (커서가 튀지 않도록)
        const suppress = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", suppress, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", suppress, true), 0);

        if (!d || !source) return;
        const dstLoc = activeTab(usePanes.getState(), d.pane).location;
        const dst = d.folder ? childLocation(dstLoc, d.folder) : dstLoc;
        if (sameLocation(source, dst)) return;
        if (targets.some((t) => sameLocation(childLocation(t.location, t.name), dst))) return;
        void planTransferTo(targets, dst, ev.ctrlKey ? "copy" : "move", open, showToast);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
    },
    [id, open, showToast],
  );
}
