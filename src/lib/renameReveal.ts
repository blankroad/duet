import type { Location } from "@/types/bindings";
import { usePanes, computeDisplayed, type PaneId } from "@/stores/panes";
import { sameLocationDir } from "@/lib/entryDnd";

/**
 * 인라인 이름 바꾸기 성공 직후, 목록에서 옛 이름을 새 이름으로 바로 바꾸고 커서·선택을
 * 새 이름에 둔다 (Finder/탐색기 관례).
 *
 * 새로고침은 커서를 **이름**으로 따라가는데(panes.setEntries), 옛 이름은 사라졌으니
 * 그대로 두면 커서가 같은 인덱스의 다른 파일로 떨어진다. 새로고침 전에 이름을 먼저
 * 바꿔 두면 새로고침이 새 이름을 찾아 그 자리를 지킨다.
 *
 * 그 사이 사용자가 다른 폴더·탭으로 옮겼으면 아무것도 하지 않는다.
 */
export function followRenamedEntry(
  paneId: PaneId,
  parent: Location,
  oldName: string,
  newName: string,
): void {
  usePanes.setState((s) => {
    const pane = s.panes[paneId];
    const tab = pane.tabs[pane.activeTabIndex];
    if (!tab || !sameLocationDir(tab.location, parent)) return s;
    if (!tab.entries.some((e) => e.name === oldName)) return s;
    const entries = tab.entries.map((e) =>
      e.name === oldName ? { ...e, name: newName } : e,
    );
    const selected = new Set(
      [...tab.selected].map((n) => (n === oldName ? newName : n)),
    );
    const next = { ...tab, entries, selected };
    const at = computeDisplayed(next).findIndex((e) => e.name === newName);
    const tabs = pane.tabs.map((t, i) =>
      i === pane.activeTabIndex
        ? { ...next, cursorIndex: at >= 0 ? at : tab.cursorIndex }
        : t,
    );
    return { panes: { ...s.panes, [paneId]: { ...pane, tabs } } };
  });
}
