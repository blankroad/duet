import type { Entry, Location } from "@/types/bindings";
import { usePanes, computeDisplayed } from "@/stores/panes";
import { sameLocationDir } from "@/lib/entryDnd";

/** Keep completion attached to the originating tab, including after tab switches. */
export function revealCreatedEntry(
  tabId: string | undefined,
  parent: Location,
  name: string,
  entries: Entry[],
): void {
  if (!tabId || !entries.some((e) => e.name === name)) return;
  usePanes.setState((s) => ({
    panes: Object.fromEntries(
      Object.entries(s.panes).map(([id, pane]) => [
        id,
        {
          ...pane,
          tabs: pane.tabs.map((tab) => {
            if (tab.id !== tabId || !sameLocationDir(tab.location, parent))
              return tab;
            const entry = entries.find((e) => e.name === name)!;
            let next = {
              ...tab,
              entries,
              loading: false,
              loadedAt: Date.now(),
              selected: new Set([name]),
              showHidden: tab.showHidden || entry.hidden,
            };
            if (!computeDisplayed(next).some((e) => e.name === name))
              next = { ...next, filter: "", filterFocused: false };
            return {
              ...next,
              cursorIndex: computeDisplayed(next).findIndex(
                (e) => e.name === name,
              ),
            };
          }),
        },
      ]),
    ) as typeof s.panes,
  }));
}

export function validateEntryName(
  name: string,
  windows: boolean,
): "invalidName" | "invalidWindowsName" | null {
  if (!name.trim() || name === "." || name === ".." || /[/\\\0]/.test(name))
    return "invalidName";
  if (
    windows &&
    (/[\x00-\x1f<>:"|?*]/.test(name) ||
      /[. ]$/.test(name) ||
      /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(
        name.split(".")[0]!.trimEnd(),
      ))
  )
    return "invalidWindowsName";
  return null;
}
