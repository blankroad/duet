import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import { useJournal } from "@/stores/journal";

/**
 * 백엔드의 `journal-changed-event` 를 구독해서 journal store 를 자동 동기화.
 * 부트스트랩 시 tail 100 도 로드.
 */
export function useJournalEvents() {
  const pushed = useJournal((s) => s.pushed);
  const markUndone = useJournal((s) => s.markUndone);
  const setHistory = useJournal((s) => s.setHistory);

  // 부트스트랩: tail 100 로드
  useEffect(() => {
    let cancelled = false;
    commands.undoHistory(100).then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setHistory(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [setHistory]);

  // 라이브 이벤트 구독
  useEffect(() => {
    const unlistenP = events.journalChangedEvent.listen(({ payload }) => {
      if (payload.change === "push") pushed(payload.entry);
      else if (payload.change === "undone") markUndone(payload.entry.id);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [pushed, markUndone]);
}
