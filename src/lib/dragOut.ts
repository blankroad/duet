import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { commands } from "@/types/bindings";
import type { EntryRef } from "@/types/bindings";
import { useToast } from "@/stores/toast";
import { formatErr } from "@/lib/error";

/**
 * duet → OS(탐색기/파인더 등) 파일 드래그-아웃.
 *
 * `tauri-plugin-drag` (crabnebula) 로 네이티브 OS 드래그 세션 시작 — 로컬 파일만
 * (SSH 는 로컬 경로가 없어 NotSupported, 임시 다운로드는 후속). 항상 copy(원본 보존).
 *
 * 중요(타이밍): 네이티브 드래그는 **mousedown 제스처 안에서 즉시** 시작해야 OS 가
 * 현재 누름에 드래그를 붙인다. 그래서 절대경로 해석(IPC)을 드래그 직전에 await 하면
 * 안 된다 — 한 번의 이벤트루프 양보 사이에 제스처가 끊겨 드래그가 안 붙는다.
 * → 경로 해석(`resolveDragPaths`)은 선택 변경 시 미리 해 두고, 드래그 시작
 *   (`startDragWithPaths`)은 캐시된 경로로 동기 발사한다.
 */

// 드래그 프리뷰 아이콘 — 1x1 투명 PNG (OS 가 기본 파일 프리뷰로 대체). icon 은 필수 인자.
const DRAG_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * items(로컬 항목)의 절대경로를 백엔드에서 해석. 경로 결합은 백엔드 담당(§7).
 * 비로컬이 섞이면 backend 가 NotSupported → 빈 배열 + 토스트.
 */
export async function resolveDragPaths(items: EntryRef[]): Promise<string[]> {
  if (items.length === 0) return [];
  const r = await commands.localAbsPaths(items);
  if (r.status !== "ok") {
    useToast.getState().show(`Drag out: ${formatErr(r.error)}`);
    return [];
  }
  return r.data;
}

/**
 * 이미 해석된 절대경로로 네이티브 OS 드래그를 시작. **mousedown 핸들러 안에서 동기
 * 호출**할 것(앞에 await 두지 말 것) — 그래야 제스처에 드래그가 붙는다.
 */
export function startDragWithPaths(paths: string[]): void {
  if (paths.length === 0) return;
  void startDrag({ item: paths, icon: DRAG_ICON, mode: "copy" }).catch((e) => {
    useToast.getState().show(`Drag out failed: ${formatErr(e)}`);
  });
}

/**
 * 편의 함수: 해석 후 드래그. 드래그 직전 await 가 있으므로 제스처가 끊길 수 있다 —
 * 캐시 미스(선택 직후 즉시 드래그) 폴백으로만 사용.
 */
export async function startDragOut(items: EntryRef[]): Promise<void> {
  startDragWithPaths(await resolveDragPaths(items));
}
