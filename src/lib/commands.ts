export type CommandCategory =
  | "Tab"
  | "Navigation"
  | "View"
  | "Sort"
  | "Filter"
  | "Search"
  | "Connection"
  | "Settings"
  | "User";

export interface Command {
  id: string;
  label: string;
  category: CommandCategory;
  defaultKey?: string;
  action: () => void;
  /** input/textarea 안에서도 핸들러 동작? 디폴트 false. */
  allowInInput?: boolean;
}

/** App 가 호출 시 모든 callback 주입. */
export interface BuiltinDeps {
  // tab
  openTab: () => void;
  closeActiveTab: () => void;
  nextTab: () => void;
  prevTab: () => void;
  // navigation
  back: () => void;
  forward: () => void;
  // view
  refresh: () => void;
  toggleHidden: () => void;
  toggleSidebar: () => void;
  togglePreview: () => void;
  viewDetails: () => void;
  viewGrid: () => void;
  viewTiles: () => void;
  // sort (5)
  sortByName: () => void;
  sortBySize: () => void;
  sortByMtime: () => void;
  sortByKind: () => void;
  sortByExt: () => void;
  // filter / search
  focusFilter: () => void;
  openSearch: () => void;
  // settings / palette
  openSettings: () => void;
  openPalette: () => void;
  // close (Ctrl+Q on non-mac)
  quit: () => void;
}

export function buildBuiltins(deps: BuiltinDeps): Command[] {
  return [
    { id: "tab.new", label: "New tab", category: "Tab", defaultKey: "Ctrl+T", action: deps.openTab },
    { id: "tab.close", label: "Close tab", category: "Tab", defaultKey: "Ctrl+W", action: deps.closeActiveTab },
    { id: "tab.next", label: "Next tab", category: "Tab", defaultKey: "Ctrl+Tab", action: deps.nextTab },
    { id: "tab.prev", label: "Previous tab", category: "Tab", defaultKey: "Ctrl+Shift+Tab", action: deps.prevTab },
    { id: "nav.back", label: "Go back", category: "Navigation", defaultKey: "Alt+Left", action: deps.back },
    { id: "nav.forward", label: "Go forward", category: "Navigation", defaultKey: "Alt+Right", action: deps.forward },
    { id: "view.refresh", label: "Refresh", category: "View", defaultKey: "Ctrl+R", action: deps.refresh },
    { id: "view.refreshF5", label: "Refresh (F5)", category: "View", defaultKey: "F5", action: deps.refresh },
    { id: "view.toggleHidden", label: "Toggle hidden files", category: "View", defaultKey: "Ctrl+H", action: deps.toggleHidden },
    { id: "view.toggleSidebar", label: "Toggle sidebar", category: "View", defaultKey: "Ctrl+B", action: deps.toggleSidebar },
    { id: "view.togglePreview", label: "Toggle preview", category: "View", defaultKey: "F11", action: deps.togglePreview },
    { id: "view.details", label: "View: Details", category: "View", action: deps.viewDetails },
    { id: "view.grid", label: "View: Grid", category: "View", action: deps.viewGrid },
    { id: "view.tiles", label: "View: Tiles", category: "View", action: deps.viewTiles },
    { id: "sort.byName", label: "Sort by name", category: "Sort", defaultKey: "Ctrl+Shift+1", action: deps.sortByName },
    { id: "sort.bySize", label: "Sort by size", category: "Sort", defaultKey: "Ctrl+Shift+2", action: deps.sortBySize },
    { id: "sort.byMtime", label: "Sort by modified", category: "Sort", defaultKey: "Ctrl+Shift+3", action: deps.sortByMtime },
    { id: "sort.byKind", label: "Sort by kind", category: "Sort", defaultKey: "Ctrl+Shift+4", action: deps.sortByKind },
    { id: "sort.byExt", label: "Sort by extension", category: "Sort", defaultKey: "Ctrl+Shift+5", action: deps.sortByExt },
    { id: "filter.focus", label: "Focus filter", category: "Filter", defaultKey: "Ctrl+F", action: deps.focusFilter },
    { id: "search.global", label: "Global search", category: "Search", defaultKey: "Ctrl+Shift+F", action: deps.openSearch },
    { id: "settings.open", label: "Open settings", category: "Settings", defaultKey: "Ctrl+,", action: deps.openSettings },
    { id: "palette.open", label: "Command palette", category: "Settings", defaultKey: "Ctrl+P", action: deps.openPalette },
    { id: "app.quit", label: "Quit", category: "Settings", defaultKey: "Ctrl+Q", action: deps.quit },
  ];
}
