import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import { useIndexStatus } from "@/stores/indexStatus";

/**
 * 앱 시작 시 전체 드라이브 파일명 인덱싱을 백그라운드로 트리거하고,
 * 진행률(IndexProgressEvent)을 구독해 전역 상태로 반영.
 *
 * 인덱스가 완료되면 글로벌 검색(파일명)이 전체 드라이브를 즉시 커버한다.
 * 빌드 중에는 검색이 현재 폴더 온디맨드로 폴백된다(백엔드 index_search).
 */
export function useIndexProgressEvents() {
  const setProgress = useIndexStatus((s) => s.setProgress);

  // 시작 시 전체 드라이브 인덱싱 시작(백그라운드, 즉시 반환).
  useEffect(() => {
    void commands.indexBuildGlobal();
  }, []);

  // 진행률/완료 이벤트 구독.
  useEffect(() => {
    const unlisten = events.indexProgressEvent.listen(({ payload }) => {
      setProgress(payload.indexed, payload.done);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [setProgress]);
}
