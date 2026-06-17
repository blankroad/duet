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
import { childLocation, sameLocation } from "@/lib/entryDnd";
import { resolveDropAt } from "@/lib/dropTarget";
import { planTransferTo } from "@/lib/fileActions";
import { resolveDragPaths, startDragWithPaths } from "@/lib/dragOut";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";

/**
 * 항목 행/셀의 포인터 기반 드래그. 시작 시점의 Ctrl + 소스 종류로 메커니즘 결정:
 *
 * - **로컬 + Ctrl 없음**: **OS 네이티브 드래그**(`startDrag`) → 탐색기/다른 앱/다른 패널
 *   어디로든 드롭(창 밖 가능), 항상 copy. 절대경로는 mousedown 에 미리 해석해 두고 임계
 *   도달 시 **동기 발사**(제스처 유지).
 * - **로컬 + Ctrl**: 인앱 DOM 드래그 → 패널↔패널 **이동**(onUp 에서 planTransferTo move).
 *   (OS 드래그는 시작 후 못 바꾸므로 이동/내보내기는 *시작 시점* Ctrl 로 결정.)
 * - **원격(SSH)**: 로컬 경로가 없어 OS 드래그-아웃 불가 → 인앱 DOM 드래그(복사 기본 /
 *   Ctrl=이동). 항상 확인 다이얼로그 경유.
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

      // 로컬: OS 드래그-아웃용 절대경로를 미리 해석(임계 도달 시 await 없이 발사하기 위함).
      let osPaths: string[] = [];
      if (isLocal) {
        void resolveDragPaths(targets).then((p) => {
          osPaths = p;
        });
      }

      let started = false;
      let handedToOs = false; // 로컬: OS 가 드래그를 인계받음(이후 onUp 무시)

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
          if (isLocal && !ev.ctrlKey) {
            // 로컬 + Ctrl 안 누름 → OS 네이티브 드래그로 인계(탐색기/다른 앱/다른 패널 copy).
            // Ctrl 누르고 시작하면 아래 인앱 드래그로 가서 패널↔패널 '이동'(onUp)이 된다.
            // (OS 드래그는 시작 후 못 바꾸므로 이동/내보내기는 시작 시점 Ctrl 로 결정.)
            handedToOs = true;
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp, true);
            if (osPaths.length > 0) {
              startDragWithPaths(osPaths);
            } else {
              // 경로 해석이 아직이면(선택 직후 즉시 드래그) 해석 후 발사 — 폴백.
              void resolveDragPaths(targets).then(startDragWithPaths);
            }
            suppressNextClick();
            return;
          }
          // 원격(SSH): 인앱 DOM 드래그(고스트).
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

      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
        if (handedToOs) return; // OS 가 드롭 처리 — 인앱 후처리 없음
        if (!started) return; // 단순 클릭 — 행의 onClick 이 처리
        document.body.style.cursor = "";
        const { source, targets: dragTargets } = useDragState.getState();
        const d = resolveDropAt(ev.clientX, ev.clientY);
        useDragState.getState().end();
        suppressNextClick();

        if (!d || !source) return;
        const dstLoc = activeTab(usePanes.getState(), d.pane).location;
        const dst = d.folder ? childLocation(dstLoc, d.folder) : dstLoc;
        if (sameLocation(source, dst)) return;
        if (
          dragTargets.some((t) =>
            sameLocation(childLocation(t.location, t.name), dst),
          )
        )
          return;
        void planTransferTo(
          dragTargets,
          dst,
          ev.ctrlKey ? "move" : "copy",
          open,
          showToast,
        );
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
    },
    [id, open, showToast],
  );
}
