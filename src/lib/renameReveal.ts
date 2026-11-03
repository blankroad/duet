import type { Location } from "@/types/bindings";
import { usePanes, computeDisplayed, type PaneId } from "@/stores/panes";
import { sameLocationDir } from "@/lib/entryDnd";
import { isWindows } from "@/lib/fileIcon";

/**
 * 인라인 이름 바꾸기 성공 직후, 목록에서 옛 이름을 새 이름으로 바로 바꾸고 커서·선택을
 * 새 이름에 둔다 (Finder/탐색기 관례).
 *
 * 새로고침은 커서를 **이름**으로 따라가는데(panes.setEntries), 옛 이름은 사라졌으니
 * 그대로 두면 커서가 같은 인덱스의 다른 파일로 떨어진다. 새로고침 전에 이름을 먼저
 * 바꿔 두면 새로고침이 새 이름을 찾아 그 자리를 지킨다.
 *
 * - **이름을 바꾼 그 탭(tabId)** 만 고친다. 원격 응답을 기다리는 사이 같은 폴더를 보는
 *   다른 탭으로 옮겼다면 그 탭의 커서는 건드리지 않는다. 원래 탭이 다른 폴더로 갔으면
 *   아무것도 하지 않는다.
 * - 원래 탭이 지금 보이는 탭이면 새 이름이 필터·숨김에 가려지지 않게 풀고(생성 성공의
 *   reveal 과 같은 정책) 커서를 옮긴다. 보이지 않는 탭이면 목록·선택만 고친다.
 */
export function followRenamedEntry(
  paneId: PaneId,
  tabId: string,
  parent: Location,
  oldName: string,
  newName: string,
): void {
  usePanes.setState((s) => {
    const pane = s.panes[paneId];
    const i = pane.tabs.findIndex((t) => t.id === tabId);
    const tab = pane.tabs[i];
    if (!tab || !sameLocationDir(tab.location, parent)) return s;
    if (!tab.entries.some((e) => e.name === oldName)) return s;
    // POSIX 에선 점으로 시작하면 숨김 — 새로고침 전에도 같은 판정을 쓴다.
    const dotHidden =
      newName.startsWith(".") &&
      !(parent.source.kind === "local" && isWindows());
    const entries = tab.entries.map((e) =>
      e.name === oldName
        ? { ...e, name: newName, hidden: e.hidden || dotHidden }
        : e,
    );
    const selected = new Set(
      [...tab.selected].map((n) => (n === oldName ? newName : n)),
    );
    const prevName = computeDisplayed(tab)[tab.cursorIndex]?.name;
    let next = { ...tab, entries, selected };
    const focusNew = i === pane.activeTabIndex;
    if (focusNew) {
      const renamed = entries.find((e) => e.name === newName)!;
      if (renamed.hidden && !next.showHidden)
        next = { ...next, showHidden: true };
      if (!computeDisplayed(next).some((e) => e.name === newName))
        next = { ...next, filter: "", filterFocused: false };
    }
    const shown = computeDisplayed(next);
    const want = focusNew || prevName === oldName ? newName : prevName;
    const at = shown.findIndex((e) => e.name === want);
    const tabs = pane.tabs.slice();
    tabs[i] = { ...next, cursorIndex: at >= 0 ? at : tab.cursorIndex };
    return { panes: { ...s.panes, [paneId]: { ...pane, tabs } } };
  });
}
