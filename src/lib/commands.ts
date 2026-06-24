export type CommandCategory =
  | "Tab"
  | "Navigation"
  | "View"
  | "Sort"
  | "Filter"
  | "Search"
  | "Select"
  | "File"
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
  editPath: () => void;
  jump: () => void;
  // view
  refresh: () => void;
  toggleHidden: () => void;
  toggleSidebar: () => void;
  togglePreview: () => void;
  toggleSyncBrowse: () => void;
  quickLook: () => void;
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
  // select (glob/substring pattern)
  selectByPattern: () => void;
  deselectByPattern: () => void;
  // shelf (drop stack)
  shelfAdd: () => void;
  shelfApplyCopy: () => void;
  shelfApplyMove: () => void;
  shelfClear: () => void;
  // file (two-pane)
  compareFolders: () => void;
  threeWayCompare: () => void;
  syncFolders: () => void;
  swapPanes: () => void;
  moveTabToOther: () => void;
  // bookmark
  toggleBookmark: () => void;
  // settings / palette
  openSettings: () => void;
  openPalette: () => void;
  // close (Ctrl+Q on non-mac)
  quit: () => void;
  // file ops (재바인딩 가능한 1급 명령으로 통합 — 이전 useDestructiveKeys 하드코딩 대체)
  copy: () => void;
  move: () => void;
  rename: () => void;
  newFolder: () => void;
  delete: () => void;
  deletePerm: () => void;
  copyPath: () => void;
  copyName: () => void;
  clipCopy: () => void;
  clipCut: () => void;
  clipPaste: () => void;
  undo: () => void;
  // ssh
  setupKeyAuth: () => void;
}

export function buildBuiltins(deps: BuiltinDeps): Command[] {
  return [
    {
      id: "tab.new",
      label: "New tab",
      category: "Tab",
      defaultKey: "Ctrl+T",
      action: deps.openTab,
    },
    {
      id: "tab.close",
      label: "Close tab",
      category: "Tab",
      defaultKey: "Ctrl+W",
      action: deps.closeActiveTab,
    },
    {
      id: "tab.next",
      label: "Next tab",
      category: "Tab",
      defaultKey: "Ctrl+Tab",
      action: deps.nextTab,
    },
    {
      id: "tab.prev",
      label: "Previous tab",
      category: "Tab",
      defaultKey: "Ctrl+Shift+Tab",
      action: deps.prevTab,
    },
    {
      id: "tab.moveToOther",
      label: "Move tab to other panel",
      category: "Tab",
      action: deps.moveTabToOther,
    },
    {
      id: "nav.back",
      label: "Go back",
      category: "Navigation",
      defaultKey: "Alt+Left",
      action: deps.back,
    },
    {
      id: "nav.forward",
      label: "Go forward",
      category: "Navigation",
      defaultKey: "Alt+Right",
      action: deps.forward,
    },
    {
      id: "pane.editPath",
      label: "Edit path (type a location)",
      category: "Navigation",
      defaultKey: "Ctrl+L",
      action: deps.editPath,
    },
    {
      id: "nav.jump",
      label: "Jump to frequent folder",
      category: "Navigation",
      defaultKey: "Ctrl+J",
      action: deps.jump,
    },
    {
      id: "view.refresh",
      label: "Refresh",
      category: "View",
      defaultKey: "Ctrl+R",
      action: deps.refresh,
    },
    {
      id: "view.toggleHidden",
      label: "Toggle hidden files",
      category: "View",
      defaultKey: "Ctrl+H",
      action: deps.toggleHidden,
    },
    {
      id: "view.toggleSidebar",
      label: "Toggle sidebar",
      category: "View",
      defaultKey: "Ctrl+B",
      action: deps.toggleSidebar,
    },
    {
      id: "view.togglePreview",
      label: "Toggle preview",
      category: "View",
      defaultKey: "F11",
      action: deps.togglePreview,
    },
    {
      id: "view.quickLook",
      label: "Quick Look (large preview)",
      category: "View",
      action: deps.quickLook,
    },
    {
      id: "view.syncBrowse",
      label: "Toggle synchronized browsing",
      category: "View",
      action: deps.toggleSyncBrowse,
    },
    {
      id: "view.details",
      label: "View: Details",
      category: "View",
      action: deps.viewDetails,
    },
    {
      id: "view.grid",
      label: "View: Grid",
      category: "View",
      action: deps.viewGrid,
    },
    {
      id: "view.tiles",
      label: "View: Tiles",
      category: "View",
      action: deps.viewTiles,
    },
    {
      id: "sort.byName",
      label: "Sort by name",
      category: "Sort",
      defaultKey: "Ctrl+Shift+1",
      action: deps.sortByName,
    },
    {
      id: "sort.bySize",
      label: "Sort by size",
      category: "Sort",
      defaultKey: "Ctrl+Shift+2",
      action: deps.sortBySize,
    },
    {
      id: "sort.byMtime",
      label: "Sort by modified",
      category: "Sort",
      defaultKey: "Ctrl+Shift+3",
      action: deps.sortByMtime,
    },
    {
      id: "sort.byKind",
      label: "Sort by kind",
      category: "Sort",
      defaultKey: "Ctrl+Shift+4",
      action: deps.sortByKind,
    },
    {
      id: "sort.byExt",
      label: "Sort by extension",
      category: "Sort",
      defaultKey: "Ctrl+Shift+5",
      action: deps.sortByExt,
    },
    {
      id: "bookmark.toggle",
      label: "Bookmark this folder",
      category: "Navigation",
      defaultKey: "Ctrl+D",
      action: deps.toggleBookmark,
    },
    {
      id: "filter.focus",
      label: "Focus filter",
      category: "Filter",
      defaultKey: "Ctrl+F",
      action: deps.focusFilter,
    },
    {
      id: "search.global",
      label: "Global search",
      category: "Search",
      defaultKey: "Ctrl+Shift+F",
      action: deps.openSearch,
    },
    {
      id: "select.byPattern",
      label: "Select by pattern (glob)",
      category: "Select",
      defaultKey: "Ctrl+=",
      action: deps.selectByPattern,
    },
    {
      id: "select.removeByPattern",
      label: "Deselect by pattern (glob)",
      category: "Select",
      defaultKey: "Ctrl+-",
      action: deps.deselectByPattern,
    },
    {
      id: "shelf.add",
      label: "Add to shelf",
      category: "File",
      defaultKey: "Ctrl+Shift+A",
      action: deps.shelfAdd,
    },
    {
      id: "shelf.applyCopy",
      label: "Shelf: copy here",
      category: "File",
      action: deps.shelfApplyCopy,
    },
    {
      id: "shelf.applyMove",
      label: "Shelf: move here",
      category: "File",
      action: deps.shelfApplyMove,
    },
    {
      id: "shelf.clear",
      label: "Shelf: clear",
      category: "File",
      action: deps.shelfClear,
    },
    {
      id: "file.compare",
      label: "Compare folders (left ↔ right)",
      category: "File",
      action: deps.compareFolders,
    },
    {
      id: "file.threeWay",
      label: "3-way compare (base ↔ left ↔ right)",
      category: "File",
      action: deps.threeWayCompare,
    },
    {
      id: "file.sync",
      label: "Sync to other pane (mirror)",
      category: "File",
      action: deps.syncFolders,
    },
    {
      id: "pane.swap",
      label: "Swap panels (left ↔ right)",
      category: "View",
      defaultKey: "Ctrl+U",
      action: deps.swapPanes,
    },
    {
      id: "settings.open",
      label: "Open settings",
      category: "Settings",
      defaultKey: "Ctrl+,",
      action: deps.openSettings,
    },
    {
      id: "palette.open",
      label: "Command palette",
      category: "Settings",
      defaultKey: "Ctrl+P",
      action: deps.openPalette,
    },
    {
      id: "app.quit",
      label: "Quit",
      category: "Settings",
      defaultKey: "Ctrl+Q",
      action: deps.quit,
    },
    // 파일 작업 — 재바인딩 가능 (KeymapSection + 팔레트 노출). F5=copy 는 TC 표준.
    {
      id: "file.copy",
      label: "Copy to other panel",
      category: "File",
      defaultKey: "F5",
      action: deps.copy,
    },
    {
      id: "file.move",
      label: "Move to other panel",
      category: "File",
      defaultKey: "F6",
      action: deps.move,
    },
    {
      id: "file.rename",
      label: "Rename",
      category: "File",
      defaultKey: "F2",
      action: deps.rename,
    },
    {
      id: "file.newFolder",
      label: "New folder",
      category: "File",
      defaultKey: "F7",
      action: deps.newFolder,
    },
    {
      id: "file.delete",
      label: "Delete (to trash)",
      category: "File",
      defaultKey: "Delete",
      action: deps.delete,
    },
    {
      id: "file.deletePerm",
      label: "Delete permanently",
      category: "File",
      defaultKey: "Shift+Delete",
      action: deps.deletePerm,
    },
    {
      id: "file.clipCopy",
      label: "Copy",
      category: "File",
      defaultKey: "Ctrl+C",
      action: deps.clipCopy,
    },
    {
      id: "file.clipCut",
      label: "Cut",
      category: "File",
      defaultKey: "Ctrl+X",
      action: deps.clipCut,
    },
    {
      id: "file.clipPaste",
      label: "Paste",
      category: "File",
      defaultKey: "Ctrl+V",
      action: deps.clipPaste,
    },
    {
      id: "file.copyPath",
      label: "Copy path",
      category: "File",
      defaultKey: "Ctrl+Shift+C",
      action: deps.copyPath,
    },
    {
      id: "file.copyName",
      label: "Copy name",
      category: "File",
      defaultKey: "Ctrl+Alt+C",
      action: deps.copyName,
    },
    {
      id: "edit.undo",
      label: "Undo last operation",
      category: "File",
      defaultKey: "Ctrl+Z",
      action: deps.undo,
    },
    {
      id: "ssh.setupKeyAuth",
      label: "Set up passwordless login (this host)",
      category: "Settings",
      action: deps.setupKeyAuth,
    },
  ];
}
