import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUI } from "@/stores/ui";
import { usePanes, activeTab, type SortKey } from "@/stores/panes";
import { useSearch } from "@/stores/search";

/**
 * 글로벌 단축키.
 *
 * - Ctrl+B: 사이드바 토글
 * - Ctrl+Q: 종료 (mac은 OS 자동)
 * - Ctrl+H: 활성 패널 hidden toggle
 * - Ctrl+R / F5: 활성 패널 새로고침
 * - Ctrl+F: 활성 패널 필터 focus
 * - Ctrl+Shift+F: 글로벌 검색 (활성 탭 location root)
 * - Ctrl+Shift+1..5: sort key (name/size/mtime/kind/ext) — 같은 key 재누름 = order toggle
 * - Ctrl+T: 활성 패널 새 탭 (현재 탭 location 복제)
 * - Ctrl+W: 활성 패널 활성 탭 닫기 (1개 남으면 no-op)
 * - Ctrl+Tab: 다음 탭 (wrap)
 * - Ctrl+Shift+Tab: 이전 탭 (wrap)
 *
 * input/textarea 포커스 시 패널 단축키 무시.
 */
export function useGlobalShortcuts(opts: {
  onRefresh: (id: "left" | "right") => void;
  onBack: (id: "left" | "right") => void;
  onForward: (id: "left" | "right") => void;
}) {
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const { onRefresh, onBack, onForward } = opts;

  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isInput = tag === "input" || tag === "textarea";
      const isMod = isMac ? e.metaKey : e.ctrlKey;

      if (!isMod) {
        if (e.altKey) {
          if (isInput) return;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            onBack(usePanes.getState().activePane);
            return;
          }
          if (e.key === "ArrowRight") {
            e.preventDefault();
            onForward(usePanes.getState().activePane);
            return;
          }
        }
        if (e.key === "F5" && !isInput) {
          e.preventDefault();
          onRefresh(usePanes.getState().activePane);
        }
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — 탭 전환
      if (e.key === "Tab") {
        if (isInput) return;
        e.preventDefault();
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        if (e.shiftKey) {
          const prev = (p.activeTabIndex - 1 + p.tabs.length) % p.tabs.length;
          usePanes.getState().selectTab(id, prev);
        } else {
          const next = (p.activeTabIndex + 1) % p.tabs.length;
          usePanes.getState().selectTab(id, next);
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
        case "t":
          if (!isInput) {
            e.preventDefault();
            usePanes.getState().openTab(usePanes.getState().activePane);
          }
          break;
        case "w":
          if (!isInput) {
            e.preventDefault();
            const id = usePanes.getState().activePane;
            const p = usePanes.getState().panes[id];
            usePanes.getState().closeTab(id, p.activeTabIndex);
          }
          break;
        case "f":
          if (isInput) break;
          e.preventDefault();
          if (e.shiftKey) {
            const active = usePanes.getState().activePane;
            const tab = activeTab(usePanes.getState(), active);
            useSearch.getState().open(active, tab.location);
          } else {
            usePanes.getState().setFilterFocused(usePanes.getState().activePane, true);
          }
          break;
        case "1":
        case "2":
        case "3":
        case "4":
        case "5": {
          if (isInput || !e.shiftKey) break;
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
  }, [toggleSidebar, onRefresh, onBack, onForward]);
}
