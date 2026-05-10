import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUI } from "@/stores/ui";
import { usePanes, type SortKey } from "@/stores/panes";

/**
 * 글로벌 (패널 무관) 단축키.
 *
 * 기존: Ctrl+B (사이드바 토글), Ctrl+Q (종료)
 * 추가 (MVP-5):
 * - Ctrl+H: 활성 패널 hidden toggle
 * - Ctrl+R / F5: 활성 패널 새로고침 (onRefresh 콜백)
 * - Ctrl+1..5: 활성 패널 sort key (name/size/mtime/kind/ext) — 같은 key
 *   재클릭 시 order toggle
 *
 * 패널 키 (↑↓/Enter/...)는 useKeyboardNav 에서 처리.
 *
 * 입력 input/textarea 포커스 시 — Ctrl+H/R/1..5 무시 (input 의 자체 단축키
 * 또는 텍스트 입력 우선).
 */
export function useGlobalShortcuts(opts: { onRefresh: (id: "left" | "right") => void }) {
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const { onRefresh } = opts;

  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";

      const isMod = isMac ? e.metaKey : e.ctrlKey;

      if (!isMod) {
        // F5 = refresh (modifier 없이도 동작)
        if (e.key === "F5" && !isInput) {
          e.preventDefault();
          onRefresh(usePanes.getState().activePane);
        }
        return;
      }

      switch (e.key.toLowerCase()) {
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "q":
          if (!isMac) {
            e.preventDefault();
            void getCurrentWindow().close();
          }
          break;
        case "f":
          if (!isInput) {
            e.preventDefault();
            usePanes.getState().setFilterFocused(usePanes.getState().activePane, true);
          }
          break;
        case "h":
          if (!isInput) {
            e.preventDefault();
            usePanes.getState().toggleShowHidden(usePanes.getState().activePane);
          }
          break;
        case "r":
          if (!isInput) {
            e.preventDefault();
            onRefresh(usePanes.getState().activePane);
          }
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          if (isInput) break;
          e.preventDefault();
          const map: Record<string, SortKey> = {
            "1": "name",
            "2": "size",
            "3": "mtime",
            "4": "kind",
            "5": "ext",
          };
          const key = map[e.key];
          if (key) usePanes.getState().toggleSortKey(usePanes.getState().activePane, key);
          break;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar, onRefresh]);
}
