import { useEffect } from "react";
import { usePanes, activeTab } from "@/stores/panes";
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

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          state.moveCursor(id, 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          state.moveCursor(id, -1);
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
          if (tab.cursorIndex >= 0) {
            const entry = tab.entries[tab.cursorIndex];
            if (entry) state.toggleSelected(id, entry.name);
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onActivate, onUp]);
}
