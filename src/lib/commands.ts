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
  | "Help"
  | "User";

/**
 * command 라벨/카테고리의 표시 해석 — builtin 은 `cmd.<id>` i18n 키로 번역,
 * 동적 command(호스트/북마크 등, 키 없음)는 raw label 로 폴백. 팔레트/키맵/
 * 치트시트가 공유 — command 객체는 언어와 무관하게 재빌드 불필요.
 */
export function commandLabel(
  cmd: Command,
  t: (key: string, opts: { defaultValue: string }) => string,
): string {
  return t(`cmd.${cmd.id}`, { defaultValue: cmd.label });
}

export function commandCategory(
  category: CommandCategory | string,
  t: (key: string, opts: { defaultValue: string }) => string,
): string {
  return t(`cmdCategory.${category}`, { defaultValue: String(category) });
}

export interface Command {
  id: string;
  label: string;
  category: CommandCategory;
  defaultKey?: string;
  /** 보조 단축키 — `defaultKey` 외에 추가로 이 커맨드를 트리거(예: 필터의 `/`).
   *  keymap 재바인딩(사용자 override)이 없을 때만 폴백으로 동작. */
  altKeys?: string[];
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
  /** 사이드바 이름 필터로 포커스 — 기본 키 없음(Ctrl+F 는 패널 필터가 쓴다). */
  focusSidebarFilter: () => void;
  togglePreview: () => void;
  toggleSyncBrowse: () => void;
  /** 단일 패널 모드 토글 — 활성 패널만 전체 폭 (외부 DnD 시 창 축소용). */
  toggleSinglePane: () => void;
  /** 플로팅 드롭 트레이 창 토글 (Yoink 식 항상-위 중계 셸프). */
  toggleDropTray: () => void;
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
  /** 커서 폴더를 반대 패널에서 열기 (없으면 현재 폴더). */
  openInOtherPane: () => void;
  /** 커서 폴더를 새 탭에서 열기. */
  openInNewTab: () => void;
  /** N 번째 탭으로 (1-based). */
  gotoTab: (n: number) => void;
  /** 사이드바 N 번째 북마크로 (1-based). */
  gotoBookmark: (n: number) => void;
  /** 호스트만 필터한 팔레트 (빠른 접속). */
  quickConnect: () => void;
  selectAll: () => void;
  clearSelection: () => void;
  invertSelection: () => void;
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
  newFile: () => void;
  delete: () => void;
  deletePerm: () => void;
  /** 영구 삭제 설정 — 꺼져 있으면 커맨드 자체를 등록하지 않는다. */
  permanentDeleteEnabled: boolean;
  copyPath: () => void;
  copyName: () => void;
  calcDirSize: () => void;
  clipCopy: () => void;
  clipCut: () => void;
  clipPaste: () => void;
  undo: () => void;
  redo: () => void;
  /** 커서 항목(없으면 빈 영역) 컨텍스트 메뉴를 키보드로 오픈. */
  openContextMenu: () => void;
  /** 단축키 치트시트 다이얼로그. */
  openShortcuts: () => void;
  /** 작업 히스토리(journal) 다이얼로그. */
  openHistory: () => void;
  // ssh
  setupKeyAuth: () => void;
}

/** Alt+1..9 → N 번째 탭. 브라우저·DOpus·ForkLift 공통 관례. */
function tabGotoCommands(deps: BuiltinDeps): Command[] {
  return Array.from({ length: 9 }, (_, i) => ({
    id: `tab.goto${i + 1}`,
    label: `Go to tab ${i + 1}`,
    category: "Tab" as const,
    defaultKey: `Alt+${i + 1}`,
    action: () => deps.gotoTab(i + 1),
  }));
}

/**
 * Ctrl+Alt+1..9 → 사이드바 N 번째 북마크. TC 핫리스트·DOpus "Go FAVORITE=N" 자리.
 * (Alt+1..9 는 탭 이동이 가져갔다 — 둘 다 키맵에서 바꿀 수 있다.)
 */
function bookmarkGotoCommands(deps: BuiltinDeps): Command[] {
  return Array.from({ length: 9 }, (_, i) => ({
    id: `bookmark.goto${i + 1}`,
    label: `Go to bookmark ${i + 1}`,
    category: "Navigation" as const,
    defaultKey: `Ctrl+Alt+${i + 1}`,
    action: () => deps.gotoBookmark(i + 1),
  }));
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
      id: "view.focusSidebarFilter",
      label: "Focus sidebar filter",
      category: "View",
      // 기본 키를 주지 않는다 — Ctrl+F 는 패널 빠른 필터가 쓰고 있고, 키는 전부
      // keymap 에서 사용자가 정하는 게 원칙(CLAUDE.md). 팔레트에서는 바로 쓸 수 있다.
      action: deps.focusSidebarFilter,
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
      id: "view.singlePane",
      label: "Toggle single pane",
      category: "View",
      defaultKey: "Ctrl+Shift+D",
      action: deps.toggleSinglePane,
    },
    {
      id: "view.dropTray",
      label: "Toggle drop tray",
      category: "View",
      defaultKey: "Ctrl+Shift+Y",
      action: deps.toggleDropTray,
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
      altKeys: ["/"], // vim/less 식 빠른 찾기 (입력창에선 자동 무시 — allowInInput 없음)
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
      id: "pane.openInOther",
      label: "Open folder in other pane",
      category: "Navigation",
      defaultKey: "Ctrl+Right",
      action: deps.openInOtherPane,
    },
    {
      id: "tab.openInNew",
      label: "Open folder in new tab",
      category: "Tab",
      defaultKey: "Ctrl+Up",
      action: deps.openInNewTab,
    },
    ...tabGotoCommands(deps),
    ...bookmarkGotoCommands(deps),
    {
      id: "connection.quick",
      label: "Quick connect (search hosts)",
      category: "Connection",
      defaultKey: "Ctrl+Shift+K",
      action: deps.quickConnect,
    },
    {
      id: "select.all",
      label: "Select all",
      category: "Select",
      defaultKey: "Ctrl+A",
      action: deps.selectAll,
    },
    {
      id: "select.none",
      label: "Clear selection",
      category: "Select",
      defaultKey: "Ctrl+Shift+A",
      action: deps.clearSelection,
    },
    {
      id: "select.invert",
      label: "Invert selection",
      category: "Select",
      defaultKey: "Ctrl+Shift+I",
      // TC 관례의 NumPad `*` 도 같이 받는다.
      altKeys: ["NumpadMultiply"],
      action: deps.invertSelection,
    },
    {
      id: "select.byPattern",
      label: "Select by pattern (glob)",
      category: "Select",
      defaultKey: "Ctrl+=",
      altKeys: ["NumpadAdd"], // TC 관례
      action: deps.selectByPattern,
    },
    {
      id: "select.removeByPattern",
      label: "Deselect by pattern (glob)",
      category: "Select",
      defaultKey: "Ctrl+-",
      altKeys: ["NumpadSubtract"], // TC 관례
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
      id: "file.newFile",
      label: "New file",
      category: "File",
      // Shift+F4 = TC 의 "새 파일" 관례 (TC 는 편집기까지 열지만 여기선 생성만).
      defaultKey: "Shift+F4",
      action: deps.newFile,
    },
    {
      id: "file.delete",
      label: "Delete (to trash)",
      category: "File",
      defaultKey: "Delete",
      action: deps.delete,
    },
    // 영구 삭제는 설정에서 켠 경우에만 등록한다(CLAUDE.md §3) — 꺼져 있는데 팔레트에
    // 보이고 누르면 백엔드가 거부해 에러 토스트로 끝나던 것.
    ...(deps.permanentDeleteEnabled
      ? [
          {
            id: "file.deletePerm",
            label: "Delete permanently",
            category: "File",
            defaultKey: "Shift+Delete",
            action: deps.deletePerm,
          } as Command,
        ]
      : []),
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
      id: "file.calcSize",
      label: "Calculate folder size",
      category: "File",
      defaultKey: "Shift+Space",
      action: deps.calcDirSize,
    },
    {
      id: "edit.undo",
      label: "Undo last operation",
      category: "File",
      defaultKey: "Ctrl+Z",
      action: deps.undo,
    },
    {
      id: "edit.redo",
      label: "Redo last undone operation",
      category: "File",
      defaultKey: "Ctrl+Shift+Z",
      action: deps.redo,
    },
    {
      id: "edit.history",
      label: "Operation history",
      category: "File",
      action: deps.openHistory,
    },
    {
      id: "file.contextMenu",
      label: "Open context menu",
      category: "File",
      defaultKey: "Shift+F10",
      action: deps.openContextMenu,
    },
    {
      id: "help.shortcuts",
      label: "Keyboard shortcuts",
      category: "Help",
      defaultKey: "F1",
      action: deps.openShortcuts,
    },
    {
      id: "ssh.setupKeyAuth",
      label: "Set up passwordless login (this host)",
      category: "Settings",
      action: deps.setupKeyAuth,
    },
  ];
}
