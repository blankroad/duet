import { useEffect, useCallback, useState, useRef } from "react";
import { Pane } from "@/components/pane/Pane";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TasksBar } from "@/components/TasksBar";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { AdHocConnectDialog } from "@/components/connection/AdHocConnectDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { BatchRenameDialog } from "@/components/dialogs/BatchRenameDialog";
import { CompareDialog } from "@/components/dialogs/CompareDialog";
import { CompareScanningDialog } from "@/components/dialogs/CompareScanningDialog";
import { ThreeWayDialog } from "@/components/dialogs/ThreeWayDialog";
import { SyncDialog } from "@/components/dialogs/SyncDialog";
import { MkdirDialog } from "@/components/dialogs/MkdirDialog";
import { CompressDialog } from "@/components/dialogs/CompressDialog";
import { ArgsDialog } from "@/components/dialogs/ArgsDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DangerConfirmDialog } from "@/components/dialogs/DangerConfirmDialog";
import { ProgressModal } from "@/components/dialogs/ProgressModal";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Toast } from "@/components/Toast";
import { SearchPanel } from "@/components/SearchPanel";
import { PreviewPane } from "@/components/pane/PreviewPane";
import { QuickLook } from "@/components/pane/QuickLook";
import { TopBar } from "@/components/TopBar";
import { DragGhost } from "@/components/pane/DragGhost";
import { CommandPalette } from "@/components/CommandPalette";
import { ContextMenu } from "@/components/ContextMenu";
import { useContextMenu } from "@/stores/contextMenu";
import { buildEntryMenu, buildEmptyMenu, folderName } from "@/lib/entryMenu";
import { childLocation } from "@/lib/entryDnd";
import { isArchiveName } from "@/lib/archive";
import {
  resolveActiveTargets,
  triggerCompare,
  triggerSync,
  triggerThreeWay,
  triggerCopy,
  triggerMove,
  triggerDelete,
  triggerMkdir,
  triggerRenameSmart,
  triggerUndo,
  copySelectionPaths,
  copySelectionNames,
} from "@/lib/fileActions";
import { useCommands } from "@/stores/commands";
import { usePalette } from "@/stores/palette";
import { buildBuiltins } from "@/lib/commands";
import { useUI } from "@/stores/ui";
import { useAppSettings } from "@/stores/settings";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  applyTabDefaults,
  type PaneId,
  type SortKey,
  type ViewMode,
} from "@/stores/panes";
import { applyTheme } from "@/lib/theme";
import { useSearch } from "@/stores/search";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { bootstrapSavedHosts } from "@/stores/savedHosts";
import {
  bootstrapBookmarks,
  addBookmark,
  removeBookmark,
  findBookmarkId,
} from "@/stores/bookmarks";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import {
  bootstrapHostFavorites,
  addHostFavorite,
} from "@/stores/hostFavorites";
import { bootstrapUserAliases } from "@/stores/userAliases";
import { bootstrapAppLaunchers, setAppArgs } from "@/stores/appLaunchers";
import { bootstrapPlaces, refreshVolumes } from "@/stores/places";
import { recordRecent } from "@/stores/recents";
import { loadSession, initSessionPersist } from "@/stores/session";
import { bootstrapHostGroups } from "@/stores/sidebarGroups";
import { useDynamicCommands } from "@/lib/dynamicCommands";
import { useConnections } from "@/stores/connections";
import { useTauri } from "@/hooks/useTauri";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useSshHosts } from "@/hooks/useSshHosts";
import { useConnectionEvents } from "@/hooks/useConnectionEvents";
import { useFsChangedEvents } from "@/hooks/useFsChangedEvents";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { useKeymapEvents } from "@/hooks/useKeymapEvents";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { formatErr } from "@/lib/error";
import { formatSize } from "@/lib/format";
import { platform } from "@tauri-apps/plugin-os";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { commands } from "@/types/bindings";
import type {
  CompressFormat,
  ConnectionDto,
  CopyStrategy,
  DuetError,
  Entry,
  EntryRef,
  HostFavorite,
  Location,
  SearchHit,
  UserAlias,
  Volume,
} from "@/types/bindings";

/**
 * App 루트.
 *
 * MVP-0:
 * - 듀얼 패널 + 사이드바(추후) + 상태바(추후)
 * - IPC는 App에서 일괄 처리 → Pane은 dumb
 * - 다크/라이트 모드는 CSS만 (Task 13에서 토글 추가 가능)
 */
function App() {
  const { call: listDirectory } = useTauri("listDirectory");
  const showToast = useToast((s) => s.show);

  const navigate = useCallback(
    async (id: PaneId, path: string, opts: { pushHistory?: boolean } = {}) => {
      const state = usePanes.getState();
      const location = { ...activeTab(state, id).location, path };
      try {
        const entries = await listDirectory(location);
        state.setEntries(id, location, entries, {
          pushHistory: opts.pushHistory ?? true,
        });
        // navigate 성공 후 watcher 갱신. 실패는 silent — fs:changed 알림 안 옴
        // 정도의 영향. (사용자가 명시 새로고침으로 우회 가능.)
        void commands.paneWatchSet(id, location);
        if (opts.pushHistory !== false) recordRecent(location);
      } catch (e) {
        // 사용자가 더블클릭해도 silent fail 면 무반응으로 인식. toast 로 노출.
        const msg =
          e && typeof e === "object" && "kind" in e
            ? `${(e as { kind: string }).kind}: ${formatErr(e as DuetError)}`
            : String(e);
        showToast(`Cannot open ${path} — ${msg}`);
      }
    },
    [listDirectory, showToast],
  );

  /** location 전체를 받아 해당 패널을 이동 — Bookmark(SSH 포함) 에서 사용. */
  const navigateTo = useCallback(
    async (
      id: PaneId,
      location: Location,
      opts: { pushHistory?: boolean } = {},
    ) => {
      try {
        const entries = await listDirectory(location);
        usePanes.getState().setEntries(id, location, entries, {
          pushHistory: opts.pushHistory ?? true,
        });
        void commands.paneWatchSet(id, location);
        if (opts.pushHistory !== false) recordRecent(location);
      } catch (e) {
        const msg =
          e && typeof e === "object" && "kind" in e
            ? `${(e as { kind: string }).kind}: ${formatErr(e as DuetError)}`
            : String(e);
        showToast(`Cannot open ${location.path} — ${msg}`);
      }
    },
    [listDirectory, showToast],
  );

  /** 로컬/SSH location 을 지정 패널로 이동 — 사이드바 Places/Volumes/Recent/Bookmarks 공용. */
  const onOpenLocation = useCallback(
    (location: Location, pane: PaneId) => void navigateTo(pane, location),
    [navigateTo],
  );

  /** 활성 패널을 그 소스의 휴지통으로 이동 — 삭제 항목 보기/복구(복사·이동으로). */
  const onTrashActivate = useCallback(
    (pane?: PaneId) => {
      const id = pane ?? usePanes.getState().activePane;
      const src = activeTab(usePanes.getState(), id).location.source;
      void (async () => {
        // Windows 로컬 휴지통은 셸 가상폴더($I/$R)라 패널 탐색이 불가 →
        // 시스템 휴지통(재활용 통)을 탐색기로 연다.
        if (src.kind === "local" && platform() === "windows") {
          const r = await commands.openRecycleBin();
          if (r.status === "error")
            showToast(`Recycle Bin — ${formatErr(r.error)}`);
          return;
        }
        const r = await commands.trashLocation(src);
        if (r.status === "error") {
          showToast(`Trash unavailable — ${formatErr(r.error)}`);
          return;
        }
        await navigateTo(id, r.data);
        usePanes.getState().setTrashRoot(id, r.data.path);
      })();
    },
    [navigateTo, showToast],
  );

  /** 휴지통 항목 "Put back" — 원본 위치로 복원(원격) 후 휴지통 뷰 갱신. */
  const onPutBack = useCallback(() => {
    void (async () => {
      const id = usePanes.getState().activePane;
      const { targets } = resolveActiveTargets();
      if (targets.length === 0) return;
      let ok = 0;
      for (const t of targets) {
        const r = await commands.trashRestore(t);
        if (r.status === "ok") ok += 1;
        else showToast(`Put back failed: ${formatErr(r.error)}`);
      }
      if (ok > 0) {
        const loc = activeTab(usePanes.getState(), id).location;
        await navigateTo(id, loc, { pushHistory: false });
        showToast(`Put back ${ok} item${ok === 1 ? "" : "s"}`);
      }
    })();
  }, [navigateTo, showToast]);

  const onUp = useCallback(
    (id: PaneId) => {
      const tab = activeTab(usePanes.getState(), id);
      // 아카이브 임시 루트에서 "위로" = 아카이브 빠져나가 원래 폴더로.
      if (tab.archive && tab.location.path === tab.archive.root) {
        void navigateTo(id, tab.archive.exitTo);
        return;
      }
      const path = tab.location.path;
      if (path === "/" || path.length === 0) return;
      const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
      void navigate(id, parent);
    },
    [navigate, navigateTo],
  );

  const onActivate = useCallback(
    (id: PaneId, entry: Entry) => {
      const tab = activeTab(usePanes.getState(), id);
      // ".." 부모 행 — 위로(또는 아카이브 나가기).
      if (entry.name === "..") {
        onUp(id);
        return;
      }
      if (entry.kind === "dir") {
        const sep = tab.location.path.endsWith("/") ? "" : "/";
        void navigate(id, tab.location.path + sep + entry.name);
        return;
      }
      // 아카이브 파일 — 임시 추출 후 그 폴더로 진입(탐색기처럼 내부 열람).
      if (isArchiveName(entry.name)) {
        void (async () => {
          const r = await commands.fsArchiveOpenForBrowse({
            location: tab.location,
            name: entry.name,
          });
          if (r.status === "error") {
            showToast(`Cannot open ${entry.name} — ${formatErr(r.error)}`);
            return;
          }
          await navigateTo(id, r.data);
          usePanes.getState().setArchiveContext(id, {
            label: entry.name,
            root: r.data.path,
            exitTo: tab.location,
          });
        })();
        return;
      }
      // 일반 파일 — OS 기본 앱으로 열기 (원격은 backend 가 temp 다운로드 후 열기).
      void (async () => {
        const r = await commands.openPath(
          childLocation(tab.location, entry.name),
        );
        if (r.status === "error")
          showToast(`Cannot open ${entry.name} — ${formatErr(r.error)}`);
      })();
    },
    [navigate, navigateTo, onUp, showToast],
  );

  const onRefresh = useCallback(
    (id: PaneId) => {
      const tab = activeTab(usePanes.getState(), id);
      navigate(id, tab.location.path);
    },
    [navigate],
  );

  const onBack = useCallback(
    (id: PaneId) => {
      const loc = usePanes.getState().back(id);
      if (loc) void navigate(id, loc.path, { pushHistory: false });
    },
    [navigate],
  );

  const onForward = useCallback(
    (id: PaneId) => {
      const loc = usePanes.getState().forward(id);
      if (loc) void navigate(id, loc.path, { pushHistory: false });
    },
    [navigate],
  );

  const onKeyboardActivate = useCallback(
    (id: PaneId) => {
      const tab = activeTab(usePanes.getState(), id);
      // displayed 기준 인덱싱 (정렬/필터/".." 반영).
      const entry = computeDisplayed(tab)[tab.cursorIndex];
      if (entry) onActivate(id, entry);
    },
    [onActivate],
  );

  /** Space — Quick Look 대형 미리보기 토글 (Finder 관례). */
  const onQuickLook = useCallback(() => {
    useUI.getState().toggleQuickLook();
  }, []);

  /** 우클릭한 디렉토리를 반대 패널에서 열기. */
  const onOpenInOtherPane = useCallback(
    (srcId: PaneId, entry: Entry) => {
      if (entry.kind !== "dir") return;
      const opposite: PaneId = srcId === "left" ? "right" : "left";
      const tab = activeTab(usePanes.getState(), srcId);
      const sep = tab.location.path.endsWith("/") ? "" : "/";
      void navigate(opposite, tab.location.path + sep + entry.name);
    },
    [navigate],
  );

  /** 엔트리 우클릭 — 활성 패널/cursor/선택을 맞춘 뒤(Finder 관례) 컨텍스트 메뉴 오픈. */
  const onEntryContextMenu = useCallback(
    (id: PaneId, entry: Entry, index: number, e: React.MouseEvent) => {
      e.preventDefault();
      const s = usePanes.getState();
      s.setActivePane(id);
      s.setCursor(id, index);
      // ".." 부모 행엔 파일 작업 메뉴 없음.
      if (entry.name === "..") return;
      const tab = activeTab(s, id);
      const wasSelected = tab.selected.has(entry.name);
      if (!wasSelected) s.setSelected(id, [entry.name]);
      const selectedCount = wasSelected ? tab.selected.size : 1;
      const items = buildEntryMenu({
        paneId: id,
        entry,
        location: tab.location,
        selectedCount,
        inTrash: tab.trashRoot !== undefined,
        onActivate,
        onOpenInOtherPane,
        onPutBack,
      });
      useContextMenu.getState().openAt(e.clientX, e.clientY, items);
    },
    [onActivate, onOpenInOtherPane, onPutBack],
  );

  /** 빈 영역 우클릭 — 패널 메뉴(새 폴더/보기/정렬/북마크). */
  const onEmptyContextMenu = useCallback(
    (id: PaneId, e: React.MouseEvent) => {
      e.preventDefault();
      const s = usePanes.getState();
      s.setActivePane(id);
      const tab = activeTab(s, id);
      const items = buildEmptyMenu({
        paneId: id,
        location: tab.location,
        onRefresh,
      });
      useContextMenu.getState().openAt(e.clientX, e.clientY, items);
    },
    [onRefresh],
  );

  const onPickHit = useCallback(
    (hit: SearchHit) => {
      const rootPaneId = useSearch.getState().rootPaneId;
      if (!rootPaneId) return;
      void (async () => {
        await navigate(rootPaneId, hit.location.path);
        const tab = activeTab(usePanes.getState(), rootPaneId);
        const idx = tab.entries.findIndex((e: Entry) => e.name === hit.name);
        if (idx >= 0) usePanes.getState().setCursor(rootPaneId, idx);
        // 검색창은 닫지 않음 — 여러 결과를 연속 클릭하며 탐색 가능(Enter/Esc 로 닫기).
      })();
    },
    [navigate],
  );

  useKeyboardNav(onKeyboardActivate, onUp, onQuickLook);
  useGlobalShortcuts();
  useSshHosts();
  useConnectionEvents();
  useFsChangedEvents(onRefresh);
  useOsFileDrop();
  useJournalEvents();
  useKeymapEvents();

  const dialog = useUIDialogs((s) => s.dialog);
  const closeDialog = useUIDialogs((s) => s.close);
  const openDialog = useUIDialogs((s) => s.open);

  /** 영향받은 location 들이 현재 패널과 매칭되면 refresh. */
  const refreshAffected = useCallback(
    (locations: Location[]) => {
      const state = usePanes.getState();
      for (const id of ["left", "right"] as const) {
        const loc = activeTab(state, id).location;
        const matches = locations.some(
          (l) =>
            l.source.kind === loc.source.kind &&
            (l.source.kind === "local" ||
              ("connection_id" in l.source &&
                "connection_id" in loc.source &&
                l.source.connection_id === loc.source.connection_id)) &&
            l.path === loc.path,
        );
        if (matches) onRefresh(id);
      }
    },
    [onRefresh],
  );

  useTaskEvents(refreshAffected);

  const setBuiltins = useCommands((s) => s.setBuiltins);
  const openPalette = usePalette((s) => s.open);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const togglePreview = useUI((s) => s.togglePreview);
  const previewOpen = useUI((s) => s.previewOpen);
  const quickLookOpen = useUI((s) => s.quickLookOpen);

  useEffect(() => {
    const builtins = buildBuiltins({
      openTab: () =>
        usePanes.getState().openTab(usePanes.getState().activePane),
      closeActiveTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        usePanes.getState().closeTab(id, p.activeTabIndex);
      },
      nextTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        usePanes
          .getState()
          .selectTab(id, (p.activeTabIndex + 1) % p.tabs.length);
      },
      prevTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        usePanes
          .getState()
          .selectTab(
            id,
            (p.activeTabIndex - 1 + p.tabs.length) % p.tabs.length,
          );
      },
      back: () => onBack(usePanes.getState().activePane),
      forward: () => onForward(usePanes.getState().activePane),
      editPath: () =>
        useUI.getState().requestEditPath(usePanes.getState().activePane),
      refresh: () => onRefresh(usePanes.getState().activePane),
      toggleHidden: () =>
        usePanes.getState().toggleShowHidden(usePanes.getState().activePane),
      toggleSidebar: () => toggleSidebar(),
      togglePreview: () => togglePreview(),
      quickLook: () => useUI.getState().toggleQuickLook(),
      viewDetails: () =>
        usePanes
          .getState()
          .setViewMode(usePanes.getState().activePane, "details"),
      viewGrid: () =>
        usePanes.getState().setViewMode(usePanes.getState().activePane, "grid"),
      viewTiles: () =>
        usePanes
          .getState()
          .setViewMode(usePanes.getState().activePane, "tiles"),
      sortByName: () =>
        usePanes
          .getState()
          .toggleSortKey(usePanes.getState().activePane, "name"),
      sortBySize: () =>
        usePanes
          .getState()
          .toggleSortKey(usePanes.getState().activePane, "size"),
      sortByMtime: () =>
        usePanes
          .getState()
          .toggleSortKey(usePanes.getState().activePane, "mtime"),
      sortByKind: () =>
        usePanes
          .getState()
          .toggleSortKey(usePanes.getState().activePane, "kind"),
      sortByExt: () =>
        usePanes
          .getState()
          .toggleSortKey(usePanes.getState().activePane, "ext"),
      toggleBookmark: () => {
        const id = usePanes.getState().activePane;
        const tab = activeTab(usePanes.getState(), id);
        if (tab.location.source.kind === "ssh") {
          void bookmarkLocation(tab.location, folderName(tab.location));
          return;
        }
        const existing = findBookmarkId(tab.location);
        if (existing) void removeBookmark(existing);
        else void addBookmark(folderName(tab.location), tab.location);
      },
      focusFilter: () =>
        usePanes
          .getState()
          .setFilterFocused(usePanes.getState().activePane, true),
      openSearch: () => {
        const id = usePanes.getState().activePane;
        const tab = activeTab(usePanes.getState(), id);
        useSearch.getState().open(id, tab.location);
      },
      compareFolders: () => void triggerCompare(openDialog, showToast),
      threeWayCompare: () => void triggerThreeWay(openDialog, showToast),
      syncFolders: () => void triggerSync(openDialog, showToast),
      swapPanes: () => usePanes.getState().swapPanes(),
      moveTabToOther: () => usePanes.getState().moveActiveTabToOther(),
      openSettings: () => openDialog({ kind: "settings" }),
      openPalette: () => openPalette(),
      quit: () => {
        const isMac = navigator.userAgent.includes("Mac");
        if (!isMac) {
          void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
            void getCurrentWindow().close();
          });
        }
      },
      copy: () => void triggerCopy(openDialog, showToast),
      move: () => void triggerMove(openDialog, showToast),
      rename: () => triggerRenameSmart(openDialog, showToast),
      newFolder: () => triggerMkdir(openDialog),
      delete: () => void triggerDelete("trash", openDialog, showToast),
      deletePerm: () => void triggerDelete("permanent", openDialog, showToast),
      copyPath: () => void copySelectionPaths(showToast),
      copyName: () => void copySelectionNames(showToast),
      undo: () => void triggerUndo(showToast),
      setupKeyAuth: () => {
        const src = activeTab(
          usePanes.getState(),
          usePanes.getState().activePane,
        ).location.source;
        if (src.kind !== "ssh") {
          showToast("Active panel is not a remote host");
          return;
        }
        void (async () => {
          // window.confirm 은 Tauri 웹뷰에서 동작 안 함 → plugin-dialog 의 native confirm.
          const ok = await tauriConfirm(
            "Install your SSH public key on this host for passwordless login next time?",
            { title: "Passwordless login" },
          );
          if (!ok) return;
          const r = await commands.sshSetupKeyAuth(src.connection_id);
          showToast(
            r.status === "ok"
              ? `Passwordless login set up — installed at ${r.data}`
              : `Setup failed: ${formatErr(r.error)}`,
          );
        })();
      },
    });
    setBuiltins(builtins);
  }, [
    setBuiltins,
    openPalette,
    toggleSidebar,
    togglePreview,
    onBack,
    onForward,
    onRefresh,
    openDialog,
    showToast,
  ]);

  const onRenameSubmit = useCallback(
    async (newName: string) => {
      if (dialog.kind !== "rename") return;
      const target = dialog.target;
      closeDialog();
      const r = await commands.fsRename(target, newName);
      if (r.status === "ok") refreshAffected([target.location]);
      else showToast(`Rename failed: ${formatErr(r.error)}`);
    },
    [dialog, closeDialog, refreshAffected, showToast],
  );

  const onBatchRenameSubmit = useCallback(
    async (rule: import("@/types/bindings").RenameRule) => {
      if (dialog.kind !== "batch-rename") return;
      const targets = dialog.targets;
      closeDialog();
      const r = await commands.fsBatchRename(targets, rule);
      if (r.status === "ok") refreshAffected([targets[0]!.location]);
      else showToast(`Batch rename failed: ${formatErr(r.error)}`);
    },
    [dialog, closeDialog, refreshAffected, showToast],
  );

  const onMkdirSubmit = useCallback(
    async (name: string) => {
      if (dialog.kind !== "mkdir") return;
      const parent = dialog.parent;
      closeDialog();
      const r = await commands.fsMkdir(parent, name);
      if (r.status === "ok") refreshAffected([parent]);
      else showToast(`Mkdir failed: ${formatErr(r.error)}`);
    },
    [dialog, closeDialog, refreshAffected, showToast],
  );

  const onCompressSubmit = useCallback(
    async (name: string, format: CompressFormat) => {
      if (dialog.kind !== "compress") return;
      const items = dialog.items;
      closeDialog();
      const plan = await commands.fsCompressPlan(items, name, format);
      if (plan.status === "error") {
        showToast(`Compress failed: ${formatErr(plan.error)}`);
        return;
      }
      // execute 는 task 로 — 완료 시 affected_locations 자동 새로고침 (useTaskEvents).
      const exec = await commands.fsCompressExecute(plan.data);
      if (exec.status === "error")
        showToast(`Compress failed: ${formatErr(exec.error)}`);
    },
    [dialog, closeDialog, showToast],
  );

  /** 아카이브 browse 중 "Update archive" — 편집을 원본 아카이브로 repack (확인). */
  const onUpdateArchive = useCallback(
    (id: PaneId) => {
      const tab = activeTab(usePanes.getState(), id);
      if (!tab.archive) return;
      const archive = tab.archive;
      void (async () => {
        const original: EntryRef = {
          location: archive.exitTo,
          name: archive.label,
        };
        const r = await commands.fsRepackPlan(tab.location, original);
        if (r.status === "error") {
          showToast(`Update archive failed: ${formatErr(r.error)}`);
          return;
        }
        openDialog({
          kind: "repack-confirm",
          plan: r.data,
          label: archive.label,
        });
      })();
    },
    [showToast, openDialog],
  );

  const onRepackConfirm = useCallback(async () => {
    if (dialog.kind !== "repack-confirm") return;
    const plan = dialog.plan;
    const r = await commands.fsCompressExecute(plan);
    if (r.status === "ok") {
      openDialog({
        kind: "progress",
        title: "Updating archive…",
        taskId: r.data,
      });
    } else {
      closeDialog();
      showToast(`Update archive failed: ${formatErr(r.error)}`);
    }
  }, [dialog, openDialog, closeDialog, showToast]);

  const onDeleteConfirm = useCallback(
    async (confirmWord = "") => {
      if (dialog.kind !== "delete-confirm" && dialog.kind !== "delete-danger")
        return;
      const plan = dialog.plan;
      closeDialog();
      // 휴지통(delete-confirm)은 confirmWord 무시, 영구삭제(delete-danger)는
      // 사용자가 타이핑한 단어를 백엔드가 검증(§3).
      const r = await commands.fsDeleteExecute(plan, confirmWord);
      if (r.status === "ok") refreshAffected([plan.source_location]);
      else showToast(`Delete failed: ${formatErr(r.error)}`);
    },
    [dialog, closeDialog, refreshAffected, showToast],
  );

  /** 볼륨 우클릭 "Eject" → 확인 다이얼로그 오픈. */
  const onEject = useCallback(
    (volume: Volume) => openDialog({ kind: "eject-confirm", volume }),
    [openDialog],
  );

  const onEjectConfirm = useCallback(async () => {
    if (dialog.kind !== "eject-confirm") return;
    const { name, path } = dialog.volume;
    closeDialog();
    const r = await commands.ejectVolume(String(path));
    if (r.status === "ok") {
      showToast(`Ejected ${name}`);
      void refreshVolumes();
    } else {
      showToast(`Eject failed: ${formatErr(r.error)}`);
    }
  }, [dialog, closeDialog, showToast]);

  const onCopyConfirm = useCallback(async () => {
    if (dialog.kind !== "copy-confirm") return;
    const plan = dialog.plan;
    const r = await commands.fsCopyExecute(plan);
    if (r.status === "ok") {
      openDialog({ kind: "progress", title: "Copying…", taskId: r.data });
    } else {
      closeDialog();
      showToast(`Copy failed: ${formatErr(r.error)}`);
    }
  }, [dialog, openDialog, closeDialog, showToast]);

  const onSyncConfirm = useCallback(
    async (prune: boolean) => {
      if (dialog.kind !== "sync-confirm") return;
      const plan = { ...dialog.plan, prune };
      const r = await commands.fsSyncExecute(plan);
      if (r.status === "ok") {
        openDialog({ kind: "progress", title: "Syncing…", taskId: r.data });
      } else {
        closeDialog();
        showToast(`Sync failed: ${formatErr(r.error)}`);
      }
    },
    [dialog, openDialog, closeDialog, showToast],
  );

  const onMoveConfirm = useCallback(async () => {
    if (dialog.kind !== "move-confirm") return;
    const plan = dialog.plan;
    const r = await commands.fsMoveExecute(plan);
    if (r.status === "ok") {
      openDialog({ kind: "progress", title: "Moving…", taskId: r.data });
    } else {
      closeDialog();
      showToast(`Move failed: ${formatErr(r.error)}`);
    }
  }, [dialog, openDialog, closeDialog, showToast]);

  // 새 연결 다이얼로그 — 호스트 더블클릭/즐겨찾기 자동접속 시 alias 가 들어옴.
  const [dialogAlias, setDialogAlias] = useState<string | null>(null);
  // 연결 성공 후 이동할 (alias, path) — 호스트-인식 북마크/즐겨찾기 클릭이 세팅.
  const pendingNav = useRef<{ alias: string; path: string } | null>(null);

  /**
   * 호스트 경로로 이동 — 연결돼 있으면 지정 pane 으로 바로, 아니면 연결 다이얼로그 →
   * 성공 시 그 경로로 이동(onConnected 가 pendingNav 처리). 호스트-인식 북마크/즐겨찾기 핵심.
   */
  const onOpenHostPath = useCallback(
    (hostAlias: string, path: string, pane: PaneId) => {
      const conn = Object.values(useConnections.getState().active).find(
        (c) => c.alias === hostAlias,
      );
      if (conn) {
        void navigateTo(pane, {
          source: {
            kind: "ssh",
            connection_id: conn.id,
            host_ip: conn.host_ip,
            user: conn.user,
          },
          path,
        });
        return;
      }
      pendingNav.current = { alias: hostAlias, path };
      setDialogAlias(hostAlias);
    },
    [navigateTo],
  );

  const onAliasExecute = useCallback(
    (alias: UserAlias) => {
      if (alias.kind.kind === "navigate") {
        const id = usePanes.getState().activePane;
        void navigateTo(id, alias.kind.location);
      } else if (alias.kind.kind === "connect") {
        const targetAlias = alias.kind.saved_host_alias;
        const conns = Object.values(useConnections.getState().active);
        const conn = conns.find((c) => c.alias === targetAlias);
        if (!conn) {
          showToast(`Connect to ${targetAlias} first (use saved hosts dialog)`);
          return;
        }
        showToast(`${targetAlias} is connected`);
      }
    },
    [navigateTo, showToast],
  );

  /** 활성 탭 위치를 북마크 — SSH 면 호스트 즐겨찾기로(재접속 안전), 로컬이면 북마크. */
  const onAddBookmark = useCallback(() => {
    const tab = activeTab(usePanes.getState(), usePanes.getState().activePane);
    void bookmarkLocation(tab.location, folderName(tab.location));
  }, []);

  const onAddFavorite = useCallback(() => {
    const id = usePanes.getState().activePane;
    const tab = activeTab(usePanes.getState(), id);
    if (tab.location.source.kind !== "ssh") {
      showToast("Favorites: switch to SSH pane first");
      return;
    }
    const connId = tab.location.source.connection_id;
    const activeRecord = useConnections.getState().active;
    const conn = Object.values(activeRecord).find((c) => c.id === connId);
    if (!conn) {
      showToast("Active connection not found");
      return;
    }
    const path = String(tab.location.path);
    const defaultName = path.split("/").filter(Boolean).pop() ?? "/";
    const name = window.prompt("Favorite name", defaultName);
    if (name) void addHostFavorite(conn.alias, name, path);
  }, [showToast]);

  // ad-hoc connect 다이얼로그 (Sidebar + 버튼 또는 saved host 더블클릭)
  const [adHocOpen, setAdHocOpen] = useState(false);
  const [adHocPrefill, setAdHocPrefill] = useState<
    import("@/types/bindings").SavedHost | null
  >(null);

  const onHostActivate = useCallback((alias: string) => {
    setDialogAlias(alias);
  }, []);

  const onAdHocOpen = useCallback(() => {
    setAdHocPrefill(null);
    setAdHocOpen(true);
  }, []);

  const onSavedActivate = useCallback(
    (host: import("@/types/bindings").SavedHost) => {
      setAdHocPrefill(host);
      setAdHocOpen(true);
    },
    [],
  );

  // 팔레트/동적 커맨드용 — 활성 패널 기준 래퍼.
  const onBookmarkActivate = useCallback(
    (location: Location) =>
      onOpenLocation(location, usePanes.getState().activePane),
    [onOpenLocation],
  );
  const onFavoriteActivate = useCallback(
    (fav: HostFavorite) =>
      onOpenHostPath(
        fav.host_alias,
        String(fav.path),
        usePanes.getState().activePane,
      ),
    [onOpenHostPath],
  );

  // 모든 callback 정의 후 dynamic commands hook 등록
  useDynamicCommands({
    onSavedActivate,
    onBookmarkActivate,
    onFavoriteActivate,
    onAliasExecute,
  });

  /** 연결 성공 후 해당 패널을 SSH 위치로 이동. */
  const onConnected = useCallback(
    async (paneId: PaneId, dto: ConnectionDto) => {
      const state = usePanes.getState();
      const ssh: import("@/types/bindings").SourceId = {
        kind: "ssh",
        connection_id: dto.id,
        // backend 가 getpeername() 으로 캡처한 실제 peer IP — IpAddr deserialize
        // 위해 반드시 valid IP 문자열이어야 함 (이전엔 빈 문자열 보내서 IPC reject).
        host_ip: dto.host_ip,
        user: dto.user,
      };
      const alias = dto.alias;
      // 호스트-인식 북마크/즐겨찾기로 접속한 경우 그 경로를 먼저 시도.
      const pending = pendingNav.current;
      pendingNav.current = null;
      const candidates: string[] = [];
      if (pending && pending.alias === alias) candidates.push(pending.path);
      // 초기 경로 후보: 북마크 경로 → SFTP canonicalize(".") → "~" → "/"
      // 첫번째 성공한 listDirectory 가 패널에 적용됨.
      const homeRes = await commands.sshHomeDirectory(dto.id);
      if (homeRes.status === "ok") candidates.push(homeRes.data);
      else showToast(`ssh_home_directory failed: ${formatErr(homeRes.error)}`);
      candidates.push("~", "/");

      let succeeded = false;
      const failures: string[] = [];
      for (const path of candidates) {
        const loc = { source: ssh, path };
        try {
          const entries = await listDirectory(loc);
          state.setEntries(paneId, loc, entries);
          state.setActivePane(paneId);
          showToast(`Connected: ${alias} → ${paneId} pane (${path})`);
          succeeded = true;
          break;
        } catch (e) {
          // useTauri throws DuetError 또는 IpcError; formatErr 가 양쪽 처리.
          const msg =
            e && typeof e === "object" && "kind" in e
              ? formatErr(e as DuetError)
              : String(e);
          failures.push(`${path}: ${msg}`);
        }
      }
      if (!succeeded) {
        showToast(
          `Connected ${alias}, but list failed:\n${failures.join("\n")}`,
        );
      }
    },
    [listDirectory, showToast],
  );

  // 부트스트랩: 양쪽 패널 초기 로드 (home 디렉토리, Windows 호환) + saved hosts + bookmarks + hostFavorites
  useEffect(() => {
    (async () => {
      const result = await commands.homeDirectory();
      const home = result.status === "ok" ? result.data : "/";
      // 세션 복원: 저장된 탭 레이아웃(로컬 탭)이 있으면 그걸로, 없으면 양쪽 home.
      const saved = loadSession();
      if (saved) {
        usePanes.getState().restoreLayout(saved);
        // 복원된 탭들은 entries 캐시가 비어 있으므로 각 탭을 navigate 해 적재. 끝나면 원래 active 로.
        for (const pane of ["left", "right"] as PaneId[]) {
          const tabPaths = usePanes
            .getState()
            .panes[pane].tabs.map((t) => String(t.location.path));
          const savedActive = usePanes.getState().panes[pane].activeTabIndex;
          for (let i = 0; i < tabPaths.length; i++) {
            usePanes.getState().selectTab(pane, i);
            await navigate(pane, tabPaths[i]!, { pushHistory: false });
          }
          usePanes.getState().selectTab(pane, savedActive);
        }
        usePanes.getState().setActivePane(saved.activePane);
      } else {
        await navigate("left", home);
        await navigate("right", home);
      }
      // 탐색기 "Open in duet" 로 폴더 경로가 argv 로 들어왔으면 왼쪽 패널을 그 폴더로.
      const startup = await commands.startupOpenPath();
      if (startup.status === "ok" && startup.data) {
        await navigate("left", startup.data);
      }
      void bootstrapSavedHosts();
      // 즐겨찾기 먼저 로드 → 북마크 마이그레이션이 중복을 정확히 걸러냄.
      void bootstrapHostFavorites().then(() => bootstrapBookmarks());
      void bootstrapUserAliases();
      void bootstrapAppLaunchers();
      void bootstrapPlaces();
      void bootstrapHostGroups();
      // 설정 적용 — 테마 + 새 탭 기본값(정렬/뷰/숨김), 기존 탭에도 즉시 반영.
      void commands.settingsGet().then((r) => {
        if (r.status === "ok") {
          applyTheme(r.data.theme ?? "system");
          applyTabDefaults({
            sortKey: (r.data.default_sort ?? "name") as SortKey,
            viewMode: (r.data.default_view ?? "details") as ViewMode,
            showHidden: r.data.show_hidden_default ?? false,
          });
          useAppSettings
            .getState()
            .setSingleClickOpen(r.data.single_click_open ?? false);
        }
      });
      // 탭 레이아웃 영속 구독 시작 — 복원 navigate 가 끝난 뒤라야 churn 없음.
      initSessionPersist();
    })();
    // navigate가 deps에 들어가면 무한 루프 — 마운트 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <TopBar />
      <SearchPanel onPickHit={onPickHit} />

      <main className="flex flex-1 min-h-0 gap-1.5 p-1.5">
        <Sidebar
          onHostActivate={onHostActivate}
          onAdHocOpen={onAdHocOpen}
          onSavedActivate={onSavedActivate}
          onOpenLocation={onOpenLocation}
          onOpenHostPath={onOpenHostPath}
          onAddBookmark={onAddBookmark}
          onAddFavorite={onAddFavorite}
          onTrashActivate={onTrashActivate}
          onEject={onEject}
        />
        <Pane
          id="left"
          onNavigate={navigate}
          onActivate={onActivate}
          onRefresh={onRefresh}
          onBack={onBack}
          onForward={onForward}
          onUp={onUp}
          onEntryContextMenu={onEntryContextMenu}
          onEmptyContextMenu={onEmptyContextMenu}
          onUpdateArchive={onUpdateArchive}
        />
        <Pane
          id="right"
          onNavigate={navigate}
          onActivate={onActivate}
          onRefresh={onRefresh}
          onBack={onBack}
          onForward={onForward}
          onUp={onUp}
          onEntryContextMenu={onEntryContextMenu}
          onEmptyContextMenu={onEmptyContextMenu}
          onUpdateArchive={onUpdateArchive}
        />
        {previewOpen && <PreviewPane />}
      </main>

      <TasksBar />
      <StatusBar />

      <ConnectionDialog
        alias={dialogAlias}
        onClose={() => setDialogAlias(null)}
        onConnected={onConnected}
      />
      <AdHocConnectDialog
        open={adHocOpen}
        onClose={() => setAdHocOpen(false)}
        onConnected={onConnected}
        prefill={adHocPrefill}
      />

      {dialog.kind === "rename" && (
        <RenameDialog
          target={dialog.target}
          onClose={closeDialog}
          onSubmit={onRenameSubmit}
        />
      )}
      {dialog.kind === "batch-rename" && (
        <BatchRenameDialog
          targets={dialog.targets}
          onClose={closeDialog}
          onSubmit={onBatchRenameSubmit}
        />
      )}
      {dialog.kind === "mkdir" && (
        <MkdirDialog
          parent={dialog.parent}
          onClose={closeDialog}
          onSubmit={onMkdirSubmit}
        />
      )}
      {dialog.kind === "compress" && (
        <CompressDialog
          itemCount={dialog.items.length}
          defaultName={dialog.defaultName}
          onClose={closeDialog}
          onSubmit={onCompressSubmit}
        />
      )}
      {dialog.kind === "app-args" && (
        <ArgsDialog
          name={dialog.name}
          initial={dialog.args}
          onClose={closeDialog}
          onSubmit={(args) => {
            const appId = dialog.appId;
            closeDialog();
            void setAppArgs(appId, args);
          }}
        />
      )}
      {dialog.kind === "delete-confirm" && (
        <ConfirmDialog
          title="Delete to trash?"
          body={`${dialog.plan.total_count} item(s), ${formatSize(dialog.plan.total_size_bytes)}`}
          ctaLabel="Delete"
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onDeleteConfirm}
        />
      )}
      {dialog.kind === "compare-scanning" && <CompareScanningDialog />}
      {dialog.kind === "three-way" && (
        <ThreeWayDialog
          plan={dialog.plan}
          onClose={closeDialog}
          onApply={() => {
            const { base, left, right } = dialog.plan;
            void (async () => {
              const r = await commands.fsApplyThreeWay(base, left, right);
              if (r.status === "ok") {
                openDialog({
                  kind: "progress",
                  title: "Applying 3-way…",
                  taskId: r.data,
                });
              } else {
                closeDialog();
                showToast(`3-way apply failed: ${formatErr(r.error)}`);
              }
            })();
          }}
        />
      )}
      {dialog.kind === "compare" && (
        <CompareDialog
          plan={dialog.plan}
          onClose={closeDialog}
          onMerge={(detectRenames) => {
            const { left, right } = dialog.plan;
            void (async () => {
              const r = await commands.fsMergeBidir(left, right, detectRenames);
              if (r.status === "ok") {
                openDialog({
                  kind: "progress",
                  title: "Merging…",
                  taskId: r.data,
                });
              } else {
                closeDialog();
                showToast(`Merge failed: ${formatErr(r.error)}`);
              }
            })();
          }}
          onApply={(decisions) => {
            const { left, right } = dialog.plan;
            void (async () => {
              const r = await commands.fsApplyCompare(left, right, decisions);
              if (r.status === "ok") {
                openDialog({
                  kind: "progress",
                  title: "Applying…",
                  taskId: r.data,
                });
              } else {
                closeDialog();
                showToast(`Apply failed: ${formatErr(r.error)}`);
              }
            })();
          }}
        />
      )}
      {dialog.kind === "sync-confirm" && (
        <SyncDialog
          srcLabel={dialog.srcLabel}
          dstLabel={dialog.dstLabel}
          src={dialog.plan.src}
          dst={dialog.plan.dst}
          onClose={closeDialog}
          onConfirm={(prune) => void onSyncConfirm(prune)}
        />
      )}
      {dialog.kind === "repack-confirm" && (
        <ConfirmDialog
          title={`Update “${dialog.label}”?`}
          body={`Repack ${dialog.plan.item_names.length} item(s) into the archive. The previous version is kept as a .bak backup and can be restored with Undo.`}
          ctaLabel="Update"
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onRepackConfirm}
        />
      )}
      {dialog.kind === "eject-confirm" && (
        <ConfirmDialog
          title={`Eject “${dialog.volume.name}”?`}
          body="The volume will be unmounted and safe to disconnect."
          ctaLabel="Eject"
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onEjectConfirm}
        />
      )}
      {dialog.kind === "delete-danger" && (
        <DangerConfirmDialog
          title="Permanently delete?"
          body={`This CANNOT be undone. ${dialog.plan.total_count} item(s).`}
          requiredWord="delete"
          onCancel={closeDialog}
          onConfirm={onDeleteConfirm}
        />
      )}
      {dialog.kind === "copy-confirm" && (
        <ConfirmDialog
          title="Copy"
          body={
            <CopyOrMovePlanBody
              count={dialog.plan.items.length}
              totalSize={dialog.plan.total_size_bytes}
              dstPath={dialog.plan.dst.path}
              conflicts={dialog.plan.conflicts.length}
              strategy={dialog.plan.strategy}
            />
          }
          ctaLabel="Copy"
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onCopyConfirm}
        />
      )}
      {dialog.kind === "move-confirm" && (
        <ConfirmDialog
          title="Move"
          body={
            <CopyOrMovePlanBody
              count={dialog.plan.items.length}
              totalSize={dialog.plan.total_size_bytes}
              dstPath={dialog.plan.dst.path}
              conflicts={dialog.plan.conflicts.length}
              strategy={dialog.plan.strategy}
            />
          }
          ctaLabel="Move"
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onMoveConfirm}
        />
      )}
      {dialog.kind === "progress" && (
        <ProgressModal
          title={dialog.title}
          taskId={dialog.taskId}
          onBackground={closeDialog}
        />
      )}
      {dialog.kind === "settings" && <SettingsDialog onClose={closeDialog} />}
      {quickLookOpen && <QuickLook />}
      <Toast />
      <CommandPalette />
      <ContextMenu />
      <DragGhost />
    </div>
  );
}

function CopyOrMovePlanBody({
  count,
  totalSize,
  dstPath,
  conflicts,
  strategy,
}: {
  count: number;
  totalSize: number;
  dstPath: string;
  conflicts: number;
  strategy: CopyStrategy;
}) {
  return (
    <div className="space-y-1">
      <div>
        {count} item(s), {formatSize(totalSize)} →{" "}
        <span className="font-mono">{dstPath}</span>
      </div>
      <div className="text-meta text-fg-muted">
        Strategy: {strategyLabel(strategy)}
      </div>
      {conflicts > 0 && (
        <div className="text-meta text-fg-muted">
          {conflicts} conflict(s) — existing file(s) will be backed up to{" "}
          <span className="font-mono">.bak.&lt;ts&gt;</span>
        </div>
      )}
    </div>
  );
}

function strategyLabel(s: CopyStrategy): string {
  switch (s.kind) {
    case "local_to_local":
      return "local";
    case "relay":
      return "relay (via this PC)";
    case "ssh_same_host":
      return "same-host (fast, server-side)";
  }
}

export default App;
