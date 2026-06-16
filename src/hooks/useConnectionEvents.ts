import { useEffect } from "react";
import { events } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { loadRemotePlaces, evictRemotePlaces } from "@/stores/places";

/**
 * 백엔드의 `connection-state-event` 를 구독하여 connections store 를 자동
 * 동기화. App 부트스트랩에서 1회 호출.
 *
 * - `connected` → upsertActive (host_ip 갱신; dialog 가 빈 문자열로 넣은 값 보강)
 * - `disconnected` → removeActive
 * - `error { message }` → setState (error) — Task 13 에서 사용
 * - `connecting` → setState (connecting) — Task 13 에서 사용
 */
export function useConnectionEvents() {
  const upsertActive = useConnections((s) => s.upsertActive);
  const removeActive = useConnections((s) => s.removeActive);
  const setState = useConnections((s) => s.setState);

  useEffect(() => {
    const unlistenP = events.connectionStateEvent.listen(({ payload }) => {
      switch (payload.state.kind) {
        case "connected":
          upsertActive({
            id: payload.id,
            alias: payload.alias,
            host_ip: payload.host_ip,
            user: payload.user,
            state: { kind: "connected" },
          });
          // 원격 호스트 Places/Volumes 로드 (활성 패널이 이 소스면 사이드바에 표시).
          void loadRemotePlaces(payload.id);
          break;
        case "disconnected":
          removeActive(payload.id);
          evictRemotePlaces(payload.id);
          break;
        case "error":
          setState(payload.id, { kind: "error", message: payload.state.message });
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
  }, [upsertActive, removeActive, setState]);
}
