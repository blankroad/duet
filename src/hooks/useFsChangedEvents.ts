import { useEffect } from "react";
import { events } from "@/types/bindings";
import { usePanes, type PaneId } from "@/stores/panes";

/**
 * 백엔드의 `fs-changed-event` 를 구독해서, 변경된 path 를 보고 있는 패널을
 * 자동 새로고침.
 *
 * 매칭 조건: 같은 source (Local 또는 같은 connection_id) + 변경 path 가
 * 패널의 현재 path 와 같거나 그 직속 child 인 경우. (디렉토리 자체 변경 +
 * 그 안의 파일 add/remove 감지)
 *
 * `refresh(paneId)` 는 App 의 onRefresh 와 같은 동작 — caller 가 그대로 전달.
 */
export function useFsChangedEvents(refresh: (paneId: PaneId) => void) {
  useEffect(() => {
    const unlistenP = events.fsChangedEvent.listen(({ payload }) => {
      const panes = usePanes.getState().panes;
      for (const id of ["left", "right"] as const) {
        const pane = panes[id];
        if (!matchesLocation(pane.location, payload.source, payload.path)) continue;
        refresh(id);
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [refresh]);
}

/**
 * 변경 이벤트가 이 패널의 location 과 관련 있는지 판정.
 */
function matchesLocation(
  paneLocation: { source: { kind: string; connection_id?: string }; path: string },
  eventSource: { kind: string; connection_id?: string },
  eventPath: string,
): boolean {
  // source 가 같은 종류인지 + (SSH 면) 같은 connection 인지
  if (paneLocation.source.kind !== eventSource.kind) return false;
  if (eventSource.kind === "ssh") {
    if (paneLocation.source.connection_id !== eventSource.connection_id) return false;
  }
  // path 가 같거나 (notify 가 디렉토리 자체 emit) 또는 직속 child (notify 가
  // 그 안의 파일 emit). 후자는 startsWith + 슬래시 1개.
  if (paneLocation.path === eventPath) return true;
  const prefix = paneLocation.path.endsWith("/") ? paneLocation.path : paneLocation.path + "/";
  if (!eventPath.startsWith(prefix)) return false;
  // 더 깊은 하위는 NonRecursive watch 라 안 옴 — 안전을 위해 한 단계만 허용.
  const rest = eventPath.slice(prefix.length);
  return !rest.includes("/");
}
