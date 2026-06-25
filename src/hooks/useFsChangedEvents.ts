import { useEffect } from "react";
import { events } from "@/types/bindings";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { eventAffectsDir } from "@/lib/entryDnd";

/**
 * 백엔드의 `fs-changed-event` 를 구독해서, 변경된 path 를 보고 있는 패널을
 * 자동 새로고침.
 *
 * 이벤트 출처:
 * - 외부 변경: `FsWatcher` (로컬 notify / SSH 폴링) — 다운로드·외부 앱 수정 등
 * - in-app 작업: `TaskQueue` 가 작업 완료 시 affected 디렉토리로 emit
 *
 * 매칭은 `eventAffectsDir` (분리자 무관 정규화 비교) — 같은 source + 변경 path 가
 * 패널의 현재 path 와 같거나 그 직속 child 인 경우.
 *
 * `refresh(paneId)` 는 App 의 onRefresh 와 같은 동작 — caller 가 그대로 전달.
 */
export function useFsChangedEvents(refresh: (paneId: PaneId) => void) {
  useEffect(() => {
    const unlistenP = events.fsChangedEvent.listen(({ payload }) => {
      const state = usePanes.getState();
      for (const id of ["left", "right"] as const) {
        const loc = activeTab(state, id).location;
        if (eventAffectsDir(payload.source, payload.path, loc)) refresh(id);
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [refresh]);
}
