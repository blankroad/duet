import { useEffect } from "react";
import { usePanes, activeTab, computeDisplayed, isParentEntry } from "@/stores/panes";
import type { PaneId } from "@/stores/panes";

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

      const state = usePanes.getState();
      const id = state.activePane;
      const tab = activeTab(state, id);
      // grid 뷰에서 ↑↓ 는 한 행(=컬럼 수)만큼, ←→ 는 1칸. 그 외 뷰는 단일 컬럼.
      const rowStep = tab.viewMode === "grid" ? Math.max(1, tab.gridCols) : 1;

      switch (e.key) {
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
          e.preventDefault();
          // Finder 관례: Space = Quick Look, Ctrl/Cmd+Space = 선택 토글.
          if (e.ctrlKey || e.metaKey) {
            if (tab.cursorIndex >= 0) {
              // displayed 기준 인덱싱(정렬/필터/".." 반영). ".." 는 선택 불가.
              const entry = computeDisplayed(tab)[tab.cursorIndex];
              if (entry && !isParentEntry(entry)) state.toggleSelected(id, entry.name);
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
