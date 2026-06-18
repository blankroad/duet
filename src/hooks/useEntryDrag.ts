import { useCallback } from "react";
import {
  usePanes,
  activeTab,
  isParentEntry,
  type PaneId,
} from "@/stores/panes";
import type { Entry, EntryRef } from "@/types/bindings";
import { exceedsThreshold } from "@/lib/marquee";
import { useDragState } from "@/stores/dragState";
import { childLocation, sameLocation, dropDestination } from "@/lib/entryDnd";
import { resolveDropAt } from "@/lib/dropTarget";
import { planTransferTo } from "@/lib/fileActions";
import { resolveDragPaths, startDragWithPaths } from "@/lib/dragOut";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";

/**
 * 항목 행/셀의 포인터 기반 드래그.
 *
 * - **창 안에서 드롭**(다른 패널/폴더): 인앱 DOM 드래그. copy 기본 / **드롭 순간 Ctrl =
 *   이동**. 모디파이어는 *드롭 시점*에 읽으므로 드래그 도중 아무 때나 Ctrl 을 눌렀다
 *   떼도 된다(시작 시점 고정 X — 그게 "될 때도 안 될 때도" 버그의 원인이었다).
 * - **창 밖으로 나가면**(로컬만): OS 네이티브 드래그로 인계 → 탐색기/다른 앱에 드롭(copy,
 *   원본 보존). 창을 떠나는 순간(`mouseout` relatedTarget=null)에 핸드오프.
 *
 * 드래그가 발생하면 뒤따르는 click(커서 이동)은 1회 억제.
 */
export function useEntryDrag(id: PaneId) {
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  return useCallback(
    (e: React.MouseEvent, entry: Entry) => {
      if (e.button !== 0) return;
      if (isParentEntry(entry)) return; // ".." 행은 드래그 소스 아님
      const sx = e.clientX;
      const sy = e.clientY;
      const tab = activeTab(usePanes.getState(), id);
      const isLocal = tab.location.source.kind === "local";
      // 드래그 대상: 누른 항목이 기존 선택에 속하면 선택 전체, 아니면 그 항목만.
      const dragWholeSelection =
        tab.selected.size > 0 && tab.selected.has(entry.name);
      const names = dragWholeSelection
        ? Array.from(tab.selected)
        : [entry.name];
      const targets: EntryRef[] = names.map((name) => ({
        location: tab.location,
        name,
      }));

      // 로컬: 창 밖으로 나갈 때 OS 드래그-아웃에 쓸 절대경로를 미리 해석(핸드오프 시 동기 발사).
      let osPaths: string[] = [];
      if (isLocal) {
        void resolveDragPaths(targets).then((p) => {
          osPaths = p;
        });
      }

      let started = false;
      let handedToOs = false; // 창 밖으로 나가 OS 가 인계 — 이후 인앱 후처리 없음

      // 드래그 직후의 합성 click 1회 억제 (커서가 튀지 않도록).
      const suppressNextClick = () => {
        const suppress = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
        };
        window.addEventListener("click", suppress, {
          capture: true,
          once: true,
        });
        setTimeout(
          () => window.removeEventListener("click", suppress, true),
          0,
        );
      };

      const onMove = (ev: MouseEvent) => {
        if (!started) {
          if (!exceedsThreshold(ev.clientX - sx, ev.clientY - sy)) return;
          started = true;
          // 선택에 없던 항목을 드래그하면 그 항목만 선택으로 교체 (marquee 와 동일 의미).
          if (!dragWholeSelection) {
            usePanes.getState().setSelected(id, [entry.name]);
          }
          useDragState.getState().start({
            source: tab.location,
            targets,
            label:
              names.length === 1 ? (names[0] ?? "") : `${names.length} items`,
            x: ev.clientX,
            y: ev.clientY,
          });
          document.body.style.cursor = "grabbing";
        }
        const d = resolveDropAt(ev.clientX, ev.clientY);
        useDragState
          .getState()
          .move(ev.clientX, ev.clientY, d?.pane ?? null, d?.folder ?? null);
      };

      // 로컬: 드래그 중 포인터가 창 밖으로 나가면 OS 드래그-아웃으로 인계(탐색기 등).
      const onOut = (ev: MouseEvent) => {
        if (!started || handedToOs || !isLocal) return;
        if (ev.relatedTarget !== null) return; // 창 안 다른 요소로 이동 — 무시
        handedToOs = true;
        useDragState.getState().end();
        document.body.style.cursor = "";
        cleanup();
        if (osPaths.length > 0) startDragWithPaths(osPaths);
        else void resolveDragPaths(targets).then(startDragWithPaths);
        suppressNextClick();
      };

      const onUp = (ev: MouseEvent) => {
        cleanup();
        if (handedToOs) return; // OS 가 드롭 처리
        if (!started) return; // 단순 클릭 — 행의 onClick 이 처리
        document.body.style.cursor = "";
        const { source, targets: dragTargets } = useDragState.getState();
        const d = resolveDropAt(ev.clientX, ev.clientY);
        useDragState.getState().end();
        suppressNextClick();

        if (!d || !source) return;
        const dstLoc = activeTab(usePanes.getState(), d.pane).location;
        const dst = dropDestination(dstLoc, d.folder); // ".." = 부모 폴더로 이동/복사
        if (sameLocation(source, dst)) return;
        if (
          dragTargets.some((t) =>
            sameLocation(childLocation(t.location, t.name), dst),
          )
        )
          return;
        // 모디파이어는 *드롭 순간* 평가 — Ctrl(또는 Shift) 누른 채 놓으면 이동.
        const mode = ev.ctrlKey || ev.shiftKey ? "move" : "copy";
        void planTransferTo(dragTargets, dst, mode, open, showToast);
      };

      const cleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        document.removeEventListener("mouseout", onOut, true);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
      document.addEventListener("mouseout", onOut, true);
    },
    [id, open, showToast],
  );
}
