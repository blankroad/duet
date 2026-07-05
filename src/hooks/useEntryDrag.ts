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
import i18n from "@/i18n";

/**
 * 항목 행/셀의 포인터 기반 드래그. **드래그 시작 시점의 Ctrl** 로 메커니즘이 갈린다:
 *
 * - **로컬 + Ctrl 없음** → **OS 네이티브 드래그**(startDrag). 탐색기/다른 앱/다른 패널
 *   어디로든 드롭(창 밖으로 나갈 수 있음), 항상 copy. 절대경로는 mousedown 에 미리
 *   해석해 두고 임계 도달 시 동기 발사(제스처 유지).
 * - **로컬 + Ctrl** → 인앱 DOM 드래그 → 패널↔패널 **이동**(onUp).
 * - **원격(SSH)** → 로컬 경로 없어 OS 드래그-아웃 불가 → 인앱 드래그(복사 기본 / Ctrl=이동).
 *
 * 왜 시작 시점인가: OS 드래그는 한 번 시작하면 도중에 "이동/내보내기"를 바꿀 수 없고
 * (네이티브 캡처), 버튼 누른 동안엔 창-이탈(mouseout)도 신뢰성 있게 안 잡힌다. 그래서
 * "드롭 순간 판정"이나 "창 밖에서 OS 인계" 방식은 drag-out 이 깨졌다(회귀). 시작 시점
 * Ctrl 로 확정하는 게 유일하게 견고한 방식 — 이동하려면 *끌기 전에* Ctrl 을 눌러둔다.
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
      // 시작 시점 모디파이어 — OS 드래그는 도중 전환 불가라 여기서 확정.
      const wantMove = e.ctrlKey || e.shiftKey;
      const tab = activeTab(usePanes.getState(), id);
      const isLocal = tab.location.source.kind === "local";
      // Ctrl 없는 로컬 = OS 드래그-아웃 경로.
      const useOsDrag = isLocal && !wantMove;
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

      // OS 드래그 경로면 절대경로를 미리 해석(임계 도달 시 await 없이 동기 발사).
      let osPaths: string[] = [];
      if (useOsDrag) {
        void resolveDragPaths(targets).then((p) => {
          osPaths = p;
        });
      }

      let started = false;
      let handedToOs = false; // OS 가 드래그를 인계받음 — 이후 인앱 후처리 없음

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
          if (useOsDrag) {
            // OS 네이티브 드래그로 인계 — 동기 발사(제스처 유지). 인앱 리스너 정리.
            handedToOs = true;
            cleanup();
            if (osPaths.length > 0) startDragWithPaths(osPaths);
            else void resolveDragPaths(targets).then(startDragWithPaths);
            suppressNextClick();
            return;
          }
          // 내부 DOM 드래그(고스트) — 패널↔패널 이동/복사.
          useDragState.getState().start({
            source: tab.location,
            targets,
            label:
              names.length === 1
                ? (names[0] ?? "")
                : i18n.t("dnd.items", { count: names.length }),
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
        // 내부 드래그는 wantMove(시작 시 Ctrl/Shift)로 이동, 아니면 복사.
        void planTransferTo(
          dragTargets,
          dst,
          wantMove ? "move" : "copy",
          open,
          showToast,
        );
      };

      const cleanup = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp, true);
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp, true);
    },
    [id, open, showToast],
  );
}
