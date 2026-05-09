import { useEffect, useCallback } from "react";
import { Pane } from "@/components/pane/Pane";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { usePanes, type PaneId } from "@/stores/panes";
import { useTauri } from "@/hooks/useTauri";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { commands } from "@/types/bindings";
import type { Entry } from "@/types/bindings";

/**
 * App 루트.
 *
 * MVP-0:
 * - 듀얼 패널 + 사이드바(추후) + 상태바(추후)
 * - IPC는 App에서 일괄 처리 → Pane은 dumb
 * - 다크/라이트 모드는 CSS만 (Task 13에서 토글 추가 가능)
 */
function App() {
  const { call: listDirectory } = useTauri("listDirectory");

  /** 디렉토리 정렬: dir 먼저, 같은 종류면 이름 오름차순 */
  const sortEntries = useCallback((entries: Entry[]): Entry[] => {
    return [...entries].sort((a, b) => {
      if (a.kind !== b.kind) {
        if (a.kind === "dir") return -1;
        if (b.kind === "dir") return 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, []);

  const navigate = useCallback(
    async (id: PaneId, path: string) => {
      const state = usePanes.getState();
      const location = { ...state.panes[id].location, path };
      try {
        const entries = await listDirectory(location);
        state.setEntries(id, location, sortEntries(entries));
      } catch {
        // useTauri가 error state에 저장 — UI는 다음 렌더에서 반영
      }
    },
    [listDirectory, sortEntries],
  );

  const onActivate = useCallback(
    (id: PaneId, entry: Entry) => {
      if (entry.kind !== "dir") return; // file open은 MVP-7
      const pane = usePanes.getState().panes[id];
      const sep = pane.location.path.endsWith("/") ? "" : "/";
      navigate(id, pane.location.path + sep + entry.name);
    },
    [navigate],
  );

  const onRefresh = useCallback(
    (id: PaneId) => {
      const pane = usePanes.getState().panes[id];
      navigate(id, pane.location.path);
    },
    [navigate],
  );

  const onKeyboardActivate = useCallback(
    (id: PaneId) => {
      const pane = usePanes.getState().panes[id];
      const entry = pane.entries[pane.cursorIndex];
      if (entry) onActivate(id, entry);
    },
    [onActivate],
  );

  const onKeyboardUp = useCallback(
    (id: PaneId) => {
      const path = usePanes.getState().panes[id].location.path;
      if (path === "/" || path.length === 0) return;
      const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
      navigate(id, parent);
    },
    [navigate],
  );

  useKeyboardNav(onKeyboardActivate, onKeyboardUp);
  useGlobalShortcuts();

  // 부트스트랩: 양쪽 패널 초기 로드 (home 디렉토리, Windows 호환)
  useEffect(() => {
    (async () => {
      const result = await commands.homeDirectory();
      const home = result.status === "ok" ? result.data : "/";
      await navigate("left", home);
      await navigate("right", home);
    })();
    // navigate가 deps에 들어가면 무한 루프 — 마운트 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>

      <main className="flex flex-1 min-h-0 gap-0">
        <Sidebar />
        <Pane id="left" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh} />
        <Pane id="right" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh} />
      </main>

      <StatusBar />
    </div>
  );
}

export default App;
