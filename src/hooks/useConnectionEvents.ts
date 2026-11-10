import { useEffect } from "react";
import { events } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { loadRemotePlaces, evictRemotePlaces } from "@/stores/places";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";

/**
 * 백엔드의 `connection-state-event` 를 구독하여 connections store 를 자동
 * 동기화. App 부트스트랩에서 1회 호출.
 *
 * - `connected` → upsertActive (host_ip 갱신; dialog 가 빈 문자열로 넣은 값 보강)
 * - `disconnected` → removeActive
 * - `error { message }` → setState (error) — Task 13 에서 사용
 * - `connecting` → setState (connecting) — Task 13 에서 사용
 *
 * 자동 재연결이 성공하면(같은 id 가 `connecting`/`error` → `connected`) 그 연결을
 * 보고 있는 패널을 `refresh` 로 다시 읽는다. 끊긴 동안 서버에서 바뀐 것이 폴링으로는
 * 잡히지 않아(mtime 같으면 갱신 없음) 옛 목록이 그대로 남았다(remote-27).
 */
export function useConnectionEvents(refresh?: (paneId: PaneId) => void) {
  const upsertActive = useConnections((s) => s.upsertActive);
  const removeActive = useConnections((s) => s.removeActive);
  const setState = useConnections((s) => s.setState);

  useEffect(() => {
    const unlistenP = events.connectionStateEvent.listen(({ payload }) => {
      switch (payload.state.kind) {
        case "connected": {
          const prev = useConnections.getState().active[payload.id]?.state;
          const recovered =
            prev?.kind === "connecting" || prev?.kind === "error";
          upsertActive({
            id: payload.id,
            alias: payload.alias,
            host_ip: payload.host_ip,
            user: payload.user,
            state: { kind: "connected" },
          });
          // 원격 호스트 Places/Volumes 로드 (활성 패널이 이 소스면 사이드바에 표시).
          void loadRemotePlaces(payload.id);
          if (recovered && refresh) refreshPanesOn(payload.id, refresh);
          break;
        }
        case "disconnected":
          removeActive(payload.id);
          evictRemotePlaces(payload.id);
          break;
        case "error":
          setState(payload.id, {
            kind: "error",
            message: payload.state.message,
          });
          break;
        case "connecting":
          setState(payload.id, { kind: "connecting" });
          break;
      }
    });
    return () => {
      // listen() 은 Promise<UnlistenFn> 반환 — cleanup 시 await 후 호출.
      unlistenP.then((fn) => fn());
    };
  }, [upsertActive, removeActive, setState, refresh]);
}

/** 활성 탭이 이 연결을 보고 있는 패널만 새로고침. 다른 탭은 전환할 때 다시 읽는다. */
function refreshPanesOn(id: string, refresh: (paneId: PaneId) => void) {
  const state = usePanes.getState();
  for (const pane of ["left", "right"] as const) {
    const src = activeTab(state, pane).location.source;
    if (src.kind === "ssh" && src.connection_id === id) refresh(pane);
  }
}
