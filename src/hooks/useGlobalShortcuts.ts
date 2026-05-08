import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useUI } from "@/stores/ui";

/**
 * 글로벌 (패널 무관) 단축키.
 * - Ctrl+B (Cmd+B on Mac): 사이드바 토글
 * - Ctrl+Q: 종료 (Mac은 Cmd+Q를 OS가 자동 처리 — 추가 핸들러 불필요)
 *
 * 패널 키 (↑↓/Enter/...)는 useKeyboardNav 에서 처리.
 */
export function useGlobalShortcuts() {
  const toggleSidebar = useUI((s) => s.toggleSidebar);

  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

    const handler = (e: KeyboardEvent) => {
      const isMod = isMac ? e.metaKey : e.ctrlKey;
      if (!isMod) return;

      switch (e.key.toLowerCase()) {
        case "b":
          e.preventDefault();
          toggleSidebar();
          break;
        case "q":
          // mac은 OS가 Cmd+Q 자동 처리 — non-Mac 에서만 핸들
          if (!isMac) {
            e.preventDefault();
            void getCurrentWindow().close();
          }
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebar]);
}
