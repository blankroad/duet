import { useEffect } from "react";
import { events, type Location } from "@/types/bindings";
import { usePanes, type PaneId } from "@/stores/panes";

/** 전체 Location 으로 이동 — App 의 `navigateTo`. 성공하면 true. */
type NavigateTo = (id: PaneId, location: Location) => Promise<boolean>;

/**
 * 탐색기 "Open in duet"·폴더 더블클릭으로 받은 **로컬** 폴더를 `side` 패널의 새 탭에서 연다.
 *
 * 새 탭을 먼저 만들고 그 탭을 전체 Location(로컬 소스)으로 이동한다 — 활성 탭에
 * 경로만 넘기면 그 탭이 원격일 때 로컬 경로를 원격에서 열었다(G-06, shell-settings-08).
 * 실행 중 인스턴스(warm start)와 시작 인자(cold start)가 같이 쓴다.
 */
export function openLocalPathInNewTab(
  side: PaneId,
  path: string,
  navigateTo: NavigateTo,
): Promise<boolean> {
  const location: Location = { source: { kind: "local" }, path };
  usePanes.getState().openTab(side, location);
  return navigateTo(side, location);
}

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
export function useOpenPathEvents(navigateTo: NavigateTo) {
  useEffect(() => {
    const unlistenP = events.openPathEvent.listen(({ payload }) => {
      const side = usePanes.getState().activePane;
      void openLocalPathInNewTab(side, payload.path, navigateTo);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [navigateTo]);
}
