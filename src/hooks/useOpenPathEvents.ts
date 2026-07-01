import { useEffect } from "react";
import { events } from "@/types/bindings";
import { usePanes, type PaneId } from "@/stores/panes";

/**
 * single-instance forward 이벤트(`OpenPathEvent`) 구독.
 *
 * duet 이 이미 실행 중일 때 폴더 더블클릭 / "Open in duet" 으로 새 인스턴스가 뜨면
 * 백엔드(single-instance 플러그인)가 그 폴더 경로를 기존 인스턴스로 forward 한다.
 * 여기서는 활성 패널에 새 탭을 만들어 그 폴더를 연다.
 *
 * Windows 전용 기능이지만 리스너는 모든 OS 에서 무해하게 상시 등록한다(이벤트가
 * 안 오면 아무 일도 없음).
 */
export function useOpenPathEvents(navigate: (id: PaneId, path: string) => void) {
  useEffect(() => {
    const unlistenP = events.openPathEvent.listen(({ payload }) => {
      const side = usePanes.getState().activePane;
      usePanes
        .getState()
        .openTab(side, { source: { kind: "local" }, path: payload.path });
      navigate(side, payload.path);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [navigate]);
}
