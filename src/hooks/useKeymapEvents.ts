import { useEffect } from "react";
import i18n from "@/i18n";
import { events } from "@/types/bindings";
import { useKeymap, bootstrapKeymap } from "@/stores/keymap";
import { useToast } from "@/stores/toast";

/**
 * 마운트 시 keymap_list IPC + KeymapChangedEvent 구독.
 * 실행 중 keymap.toml 을 잘못 저장하면(KeymapLoadFailedEvent) 이전 키를 유지한다고 경고한다.
 */
export function useKeymapEvents() {
  const setAll = useKeymap((s) => s.setAll);
  useEffect(() => {
    void bootstrapKeymap();
    const unlistenChanged = events.keymapChangedEvent.listen(({ payload }) => {
      setAll(payload.bindings);
    });
    const unlistenFailed = events.keymapLoadFailedEvent.listen(
      ({ payload }) => {
        useToast.getState().show(i18n.t("toast.keymapLoadFailed"), "warning", {
          detail: payload.message,
        });
      },
    );
    return () => {
      unlistenChanged.then((fn) => fn());
      unlistenFailed.then((fn) => fn());
    };
  }, [setAll]);
}
