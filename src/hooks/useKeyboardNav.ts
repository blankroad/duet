import { useEffect } from "react";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  isParentEntry,
} from "@/stores/panes";
import type { PaneId } from "@/stores/panes";
import { useContextMenu } from "@/stores/contextMenu";
import { useClipboard } from "@/stores/clipboard";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { usePalette } from "@/stores/palette";
import { useSearch } from "@/stores/search";
import { useUI } from "@/stores/ui";

/**
 * Esc 의 주인이 따로 있는가 — 다이얼로그·팔레트·검색·QuickLook 이 열려 있으면 그쪽이
 * 먼저 닫혀야 하므로 목록은 Esc 를 건드리지 않는다. (컨텍스트 메뉴는 위에서 이미 걸러짐.)
 */
function escapeOwnedByOverlay(): boolean {
  return (
    useUIDialogs.getState().dialog.kind !== "none" ||
    usePalette.getState().isOpen ||
    useSearch.getState().isOpen ||
    useUI.getState().quickLookOpen
  );
}

/**
 * 글로벌 키보드 네비게이션 (활성 패널 대상).
 * DESIGN.md 키 바인딩 표 — MVP-0 항목.
 *
 * input/textarea/contenteditable 포커스 중에는 무시.
 * 다른 단축키 (Ctrl+B, Ctrl+Q 등)는 useGlobalShortcuts (Task 13)에서.
 */
export function useKeyboardNav(
  onActivate: (paneId: PaneId) => void,
  onUp: (paneId: PaneId) => void,
  onQuickLook: (paneId: PaneId) => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      // 우클릭 메뉴가 열려 있으면 메뉴가 키(↑↓/Enter/Esc)를 처리 — 뒤 파일 목록은 안 건드림.
      if (useContextMenu.getState().open) return;

      const state = usePanes.getState();
      const id = state.activePane;
      const tab = activeTab(state, id);
      // grid 뷰에서 ↑↓ 는 한 행(=컬럼 수)만큼, ←→ 는 1칸. 그 외 뷰는 단일 컬럼.
      const rowStep = tab.viewMode === "grid" ? Math.max(1, tab.gridCols) : 1;

      switch (e.key) {
        // Esc — 되돌리기 계열. preventDefault 하지 않는다(놓친 오버레이가 있어도 살게).
        case "Escape": {
          if (escapeOwnedByOverlay()) break;
          // 1) 잘라내기 대기 취소가 먼저 — 흐리게 표시된 항목을 원래대로.
          //    (탐색기와 같은 관례. 취소했는데 계속 흐린 게 이 처리가 없던 버그.)
          const clip = useClipboard.getState();
          if (clip.entry?.mode === "move") {
            clip.clear();
            break;
          }
          // 2) 선택 해제 (DESIGN.md 키 바인딩 표).
          if (tab.selected.size > 0) state.setSelected(id, []);
          break;
        }
        case "ArrowDown":
          e.preventDefault();
          state.moveCursor(id, rowStep);
          break;
        case "ArrowUp":
          e.preventDefault();
          state.moveCursor(id, -rowStep);
          break;
        case "ArrowLeft":
          if (tab.viewMode === "grid") {
            e.preventDefault();
            state.moveCursor(id, -1);
          }
          break;
        case "ArrowRight":
          if (tab.viewMode === "grid") {
            e.preventDefault();
            state.moveCursor(id, 1);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (tab.cursorIndex >= 0) onActivate(id);
          break;
        case "Backspace":
          e.preventDefault();
          onUp(id);
          break;
        case "Tab":
          e.preventDefault();
          state.setActivePane(id === "left" ? "right" : "left");
          break;
        case " ":
          // Shift+Space = 폴더 크기 계산(file.calcSize, 전역 단축키) — 여기선 무시.
          if (e.shiftKey) break;
          e.preventDefault();
          // Finder 관례: Space = Quick Look, Ctrl/Cmd+Space = 선택 토글.
          if (e.ctrlKey || e.metaKey) {
            if (tab.cursorIndex >= 0) {
              // displayed 기준 인덱싱(정렬/필터/".." 반영). ".." 는 선택 불가.
              const entry = computeDisplayed(tab)[tab.cursorIndex];
              if (entry && !isParentEntry(entry))
                state.toggleSelected(id, entry.name);
            }
          } else {
            onQuickLook(id);
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onActivate, onUp, onQuickLook]);
}
