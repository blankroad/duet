import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { dropDestination } from "@/lib/entryDnd";
import type { Location, SourceId } from "@/types/bindings";
import { sourceKey } from "@/stores/places";

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

/**
 * 사이드바 드롭존의 안정 키 — 드래그 중 어떤 행이 지목됐는지 비교용.
 * (좌표마다 Location 객체를 새로 만들면 참조 비교가 안 되므로 문자열로.)
 */
export function sidebarZoneKey(source: SourceId, path: string): string {
  return `${sourceKey(source)}:${path}`;
}

/** 북마크 "여기에 추가" 존의 키 — 섹션 빈 곳에 놓으면 북마크가 된다. */
export const BOOKMARK_ADD_ZONE = "bookmark-add";

/**
 * 좌표 아래의 사이드바 드롭 대상.
 *
 * 행은 `data-drop-path` + `data-drop-source`(SourceId JSON) 를 단다 — 등록 레지스트리
 * 없이 DOM 만으로 완결되게. 행이 아니면 북마크 추가 존(`data-drop-bookmark`)인지 본다.
 * 사이드바는 패널 밖이라 `resolveDropAt`(패널/폴더)과 겹치지 않는다.
 */
export function resolveSidebarDropAt(
  x: number,
  y: number,
): { key: string; location: Location | null } | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const row = el.closest<HTMLElement>("[data-drop-path]");
  if (row) {
    const path = row.dataset.dropPath;
    const raw = row.dataset.dropSource;
    if (path === undefined || raw === undefined) return null;
    try {
      const source = JSON.parse(raw) as SourceId;
      return { key: sidebarZoneKey(source, path), location: { source, path } };
    } catch {
      return null;
    }
  }
  if (el.closest("[data-drop-bookmark]"))
    return { key: BOOKMARK_ADD_ZONE, location: null };
  return null;
}
