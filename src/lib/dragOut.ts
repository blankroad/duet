import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { commands } from "@/types/bindings";
import type { EntryRef } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

/**
 * duet → OS(파인더 등) 파일 드래그-아웃.
 *
 * `tauri-plugin-drag` (crabnebula) 로 네이티브 OS 드래그 세션 시작 — 로컬 파일만
 * (SSH 는 로컬 경로가 없어 NotSupported, 임시 다운로드는 후속). 항상 copy(원본 보존).
 * mousedown 시점에 호출해야 현재 누름에 드래그가 붙는다.
 */

// 드래그 프리뷰 아이콘 — 1x1 투명 PNG (OS 가 기본 파일 프리뷰로 대체). icon 은 필수 인자.
const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** items 의 로컬 절대경로를 받아 OS 드래그 시작. 비로컬/빈 선택이면 no-op. */
export async function startDragOut(items: EntryRef[]): Promise<void> {
  if (items.length === 0) return;
  const r = await commands.localAbsPaths(items);
  if (r.status !== "ok") {
    useToast.getState().show(`Drag out: ${formatErr(r.error)}`);
    return;
  }
  if (r.data.length === 0) return;
  try {
    await startDrag({ item: r.data, icon: DRAG_ICON, mode: "copy" });
  } catch (e) {
    useToast.getState().show(`Drag out failed: ${formatErr(e)}`);
  }
}
