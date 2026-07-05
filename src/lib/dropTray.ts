import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";
import i18n from "@/i18n";

/**
 * 플로팅 드롭 트레이 창 (Yoink 벤치마킹) — 항상-위 미니 창에 파일을 임시로
 * 떨궈 두고, 듀엣 창을 치운 뒤 외부 앱으로 드래그-아웃하는 중계 셸프.
 *
 * 메인 창과 상태를 공유하지 않는 독립 트레이(로컬 절대경로만) — in-app Shelf
 * (F5/F6 일괄 적용용)와 별개 개념. 창 label 은 "shelf" (capabilities 참조).
 */
const LABEL = "shelf";

export async function toggleDropTray(): Promise<void> {
  try {
    const existing = await WebviewWindow.getByLabel(LABEL);
    if (existing) {
      await existing.close();
      return;
    }
    const w = new WebviewWindow(LABEL, {
      // 같은 번들 — main.tsx 가 ?window=shelf 로 DropTray 루트를 렌더.
      url: "/?window=shelf",
      title: i18n.t("droptray.title"),
      width: 240,
      height: 320,
      minWidth: 180,
      minHeight: 160,
      resizable: true,
      decorations: false,
      alwaysOnTop: true,
      // macOS Spaces 어디서든 보이게 (Yoink 관례). 타 OS 는 무시됨.
      visibleOnAllWorkspaces: true,
    });
    void w.once("tauri://error", (e) => {
      useToast.getState().show(`Drop tray: ${formatErr(e.payload)}`, "error");
    });
  } catch (e) {
    useToast.getState().show(`Drop tray: ${formatErr(e)}`, "error");
  }
}
