import { useEffect } from "react";
import { events } from "@/types/bindings";
import { useKeymap, bootstrapKeymap } from "@/stores/keymap";

/**
 * 마운트 시 keymap_list IPC + KeymapChangedEvent 구독.
 */
export function useKeymapEvents() {
  const setAll = useKeymap((s) => s.setAll);
  useEffect(() => {
    void bootstrapKeymap();
    const unlistenP = events.keymapChangedEvent.listen(({ payload }) => {
      setAll(payload.bindings);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [setAll]);
}
