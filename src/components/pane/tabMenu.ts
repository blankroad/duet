import type { MouseEvent as ReactMouseEvent } from "react";
import { usePanes, type PaneId, type TabState } from "@/stores/panes";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { hasClosedTabs } from "@/stores/closedTabs";
import { isVirtualTrash } from "@/lib/trashView";
import { basename } from "@/lib/paths";
import i18n from "@/i18n";

/**
 * 탭 제목 규칙 — 폴더 이름(basename). 단 임시/가상 위치는 사람이 아는 이름으로:
 * - 아카이브 탐색: 아카이브 파일 이름 (하위 폴더면 `x.zip › sub`). 예전엔 임시 추출
 *   폴더 이름("content")이 보였다.
 * - 휴지통: "휴지통" (가상 휴지통 경로 `shell:RecycleBinFolder` 대신).
 */
export function tabTitle(tab: TabState): string {
  const path = String(tab.location.path);
  if (tab.archive) {
    const inside =
      path !== tab.archive.root && path.startsWith(tab.archive.root);
    return inside
      ? `${tab.archive.label} › ${basename(path)}`
      : tab.archive.label;
  }
  if (
    isVirtualTrash(tab.location) ||
    (tab.trashRoot !== undefined && path === tab.trashRoot)
  )
    return i18n.t("pathbar.trash");
  return basename(path, "/");
}

/**
 * 탭 우클릭 메뉴 — 고정 · 닫기 계열 · 복제/새 탭/다시 열기/반대 패널로.
 *
 * 닫기 계열의 비활성화는 탭 수가 아니라 **실제로 닫히는 탭이 있는지**로 정한다
 * (핀 탭은 일괄 닫기에서 살아남는다). 핀이 있으면 "모두 닫기"는 "고정 안 된 탭
 * 모두 닫기"가 된다.
 */
export function openTabMenu(
  e: ReactMouseEvent,
  id: PaneId,
  index: number,
): void {
  e.preventDefault();
  e.stopPropagation();
  const s = usePanes.getState();
  const tabs = s.panes[id].tabs;
  const tab = tabs[index];
  if (!tab) return;
  const anyPinned = tabs.some((t) => t.pinned);
  const closableOthers = tabs.some((t, i) => i !== index && !t.pinned);
  const closableRight = tabs.some((t, i) => i > index && !t.pinned);
  const closableAll = anyPinned ? tabs.some((t) => !t.pinned) : tabs.length > 1;
  const items: MenuEntry[] = [
    {
      id: "pin",
      label: tab.pinned ? i18n.t("tabs.unpin") : i18n.t("tabs.pin"),
      commandId: "tab.togglePin",
      onSelect: () => s.togglePinTab(id, index),
    },
    { kind: "separator" },
    {
      id: "close",
      label: i18n.t("tabs.closeThis"),
      commandId: "tab.close",
      disabled: tab.pinned || tabs.length <= 1,
      onSelect: () => s.closeTab(id, index),
    },
    {
      id: "close-others",
      label: i18n.t("tabs.closeOthers"),
      disabled: !closableOthers,
      onSelect: () => s.closeOtherTabs(id, index),
    },
    {
      id: "close-right",
      label: i18n.t("tabs.closeRight"),
      disabled: !closableRight,
      onSelect: () => s.closeTabsToRight(id, index),
    },
    {
      id: "close-all",
      label: anyPinned ? i18n.t("tabs.closeUnpinned") : i18n.t("tabs.closeAll"),
      disabled: !closableAll,
      onSelect: () => s.closeAllTabs(id),
    },
    { kind: "separator" },
    {
      id: "duplicate",
      label: i18n.t("tabs.duplicate"),
      onSelect: () => s.duplicateTab(id, index),
    },
    {
      id: "move-other",
      label: i18n.t("cmd.tab.moveToOther"),
      commandId: "tab.moveToOther",
      onSelect: () => {
        const st = usePanes.getState();
        st.setActivePane(id);
        st.selectTab(id, index);
        st.moveActiveTabToOther();
      },
    },
    {
      id: "new-tab",
      label: i18n.t("tabs.newTab"),
      commandId: "tab.new",
      onSelect: () => s.openTab(id),
    },
    {
      id: "reopen",
      label: i18n.t("tabs.reopenClosed"),
      commandId: "tab.reopenClosed",
      disabled: !hasClosedTabs(),
      onSelect: () => s.reopenClosedTab(),
    },
  ];
  useContextMenu.getState().openAt(e.clientX, e.clientY, items);
}
