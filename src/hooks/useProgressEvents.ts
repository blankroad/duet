import { useEffect } from "react";
import { events } from "@/types/bindings";
import { useUIDialogs } from "@/stores/ui-dialogs";

/**
 * `progress-event` 구독 → ui-dialogs 의 'progress' dialog 에 update.
 * MVP-3 는 단일 active op 가정 — op_id 매칭 안 함.
 */
export function useProgressEvents() {
  const setProgress = useUIDialogs((s) => s.setProgress);

  useEffect(() => {
    const unlistenP = events.progressEvent.listen(({ payload }) => {
      // payload.* nullable 필드는 specta 가 이미 `T | null` — `?? null` 불필요.
      // op_id 는 MVP-3 단일 active op 가정으로 dropped (MVP-4 multi-op 까지).
      setProgress({
        bytesDone: payload.bytes_done,
        bytesTotal: payload.bytes_total,
        speedBps: payload.speed_bps,
        etaSec: payload.eta_sec,
        percent: payload.percent,
      });
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [setProgress]);
}
