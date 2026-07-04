import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { commands } from "@/types/bindings";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { dropLocationAt } from "@/lib/dropTarget";
import { formatErr } from "@/lib/error";

/**
 * OS(파인더/탐색기)에서 끌어온 파일을 드롭 위치의 패널/폴더로 가져오기(복사).
 *
 * Tauri webview 내장 `onDragDropEvent` 구독 — drop 좌표(physical px)를 CSS px 로 환산해
 * 대상 Location 해석 후 `fs_copy_plan_external` → 기존 복사 확인 다이얼로그.
 * 외부 가져오기는 안전하게 항상 복사(원본 OS 위치 보존).
 */
export function useOsFileDrop() {
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const { paths, position } = event.payload;
        if (paths.length === 0) return;
        const dpr = window.devicePixelRatio || 1;
        const dst = dropLocationAt(position.x / dpr, position.y / dpr);
        if (!dst) return; // 패널 밖에 드롭 — 무시
        const r = await commands.fsCopyPlanExternal(paths, dst);
        if (r.status === "ok") open({ kind: "copy-confirm", plan: r.data });
        else showToast(`Import failed: ${formatErr(r.error)}`, "error");
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {
        // 비-Tauri 환경 등에서 listener 등록 실패 — 무시
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, showToast]);
}
