import { create } from "zustand";
import type { Entry, Location } from "@/types/bindings";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { childLocation } from "@/lib/entryDnd";

/**
 * 호버 미리보기 — 마우스가 올라간 항목으로 미리보기/인스펙터 패널을 갱신.
 * 리스트를 벗어나면 null → 패널은 커서 항목으로 복귀(PreviewPane 에서 처리).
 * 미리보기 패널이 닫혀 있으면 set 자체를 생략(불필요한 fetch/리렌더 회피).
 */
interface HoverState {
  target: { entry: Entry; location: Location; paneId: PaneId } | null;
  set: (t: { entry: Entry; location: Location; paneId: PaneId } | null) => void;
}

export const usePreviewHover = create<HoverState>((set) => ({
  target: null,
  set: (target) => set({ target }),
}));

/** 패널이 열려 있을 때만, 호버한 항목(`..` 제외)을 대상으로 설정. */
export function setHoverEntry(id: PaneId, entry: Entry): void {
  if (!useUI.getState().previewOpen) return;
  if (entry.name === "..") {
    usePreviewHover.getState().set(null);
    return;
  }
  const loc = activeTab(usePanes.getState(), id).location;
  usePreviewHover
    .getState()
    .set({ entry, location: childLocation(loc, entry.name), paneId: id });
}

/** 호버 해제 (리스트 벗어남) → 커서 항목으로 복귀. */
export function clearHover(): void {
  if (usePreviewHover.getState().target !== null)
    usePreviewHover.getState().set(null);
}
