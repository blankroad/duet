import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { dropDestination } from "@/lib/entryDnd";
import type { Location } from "@/types/bindings";

/**
 * 화면 좌표(CSS px) 아래의 드롭 대상 해석 — 인앱 포인터 DnD 와 OS 파일 드롭이 공유.
 * 드롭존은 `[data-drop-pane]`(패널) / `[data-drop-folder]`(폴더) data 속성으로 표시.
 */
export function resolveDropAt(
  x: number,
  y: number,
): { pane: PaneId; folder: string | null } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const paneEl = el?.closest("[data-drop-pane]");
  if (!paneEl) return null;
  const pane = paneEl.getAttribute("data-drop-pane") as PaneId;
  const folderEl = el?.closest("[data-drop-folder]");
  return { pane, folder: folderEl?.getAttribute("data-drop-folder") ?? null };
}

/** 좌표 아래 드롭 대상의 최종 Location (".."=부모, 폴더명=그 폴더, 아니면 패널 현재 디렉토리). */
export function dropLocationAt(x: number, y: number): Location | null {
  const d = resolveDropAt(x, y);
  if (!d) return null;
  const base = activeTab(usePanes.getState(), d.pane).location;
  return dropDestination(base, d.folder);
}
