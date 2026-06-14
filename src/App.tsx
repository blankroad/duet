import { useEffect, useCallback, useState } from "react";
import { Pane } from "@/components/pane/Pane";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TasksBar } from "@/components/TasksBar";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { AdHocConnectDialog } from "@/components/connection/AdHocConnectDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { MkdirDialog } from "@/components/dialogs/MkdirDialog";
import { CompressDialog } from "@/components/dialogs/CompressDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DangerConfirmDialog } from "@/components/dialogs/DangerConfirmDialog";
import { ProgressModal } from "@/components/dialogs/ProgressModal";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Toast } from "@/components/Toast";
import { SearchPanel } from "@/components/SearchPanel";
import { PreviewPane } from "@/components/pane/PreviewPane";
import { DragGhost } from "@/components/pane/DragGhost";
import { CommandPalette } from "@/components/CommandPalette";
import { ContextMenu } from "@/components/ContextMenu";
import { useContextMenu } from "@/stores/contextMenu";
import { buildEntryMenu, buildEmptyMenu, folderName } from "@/lib/entryMenu";
import { childLocation } from "@/lib/entryDnd";
import { isArchiveName } from "@/lib/archive";
import { useCommands } from "@/stores/commands";
import { usePalette } from "@/stores/palette";
import { buildBuiltins } from "@/lib/commands";
import { useUI } from "@/stores/ui";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { useSearch } from "@/stores/search";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { bootstrapSavedHosts } from "@/stores/savedHosts";
import { bootstrapBookmarks, addBookmark, removeBookmark, findBookmarkId } from "@/stores/bookmarks";
import { bootstrapHostFavorites, addHostFavorite } from "@/stores/hostFavorites";
import { bootstrapUserAliases } from "@/stores/userAliases";
import { useDynamicCommands } from "@/lib/dynamicCommands";
import { useConnections } from "@/stores/connections";
import { useTauri } from "@/hooks/useTauri";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useSshHosts } from "@/hooks/useSshHosts";
import { useConnectionEvents } from "@/hooks/useConnectionEvents";
import { useFsChangedEvents } from "@/hooks/useFsChangedEvents";
import { useDestructiveKeys } from "@/hooks/useDestructiveKeys";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { useKeymapEvents } from "@/hooks/useKeymapEvents";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { formatErr } from "@/lib/error";
import { formatSize } from "@/lib/format";
import { commands } from "@/types/bindings";
import type { CompressFormat, ConnectionDto, CopyStrategy, DuetError, Entry, HostFavorite, Location, SearchHit, UserAlias } from "@/types/bindings";

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
        state.setEntries(id, location, entries, { pushHistory: opts.pushHistory ?? true });
        // navigate 성공 후 watcher 갱신. 실패는 silent — fs:changed 알림 안 옴
        // 정도의 영향. (사용자가 명시 새로고침으로 우회 가능.)
        void commands.paneWatchSet(id, location);
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
    async (id: PaneId, location: Location, opts: { pushHistory?: boolean } = {}) => {
      try {
        const entries = await listDirectory(location);
        usePanes.getState().setEntries(id, location, entries, { pushHistory: opts.pushHistory ?? true });
        void commands.paneWatchSet(id, location);
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

  const onActivate = useCallback(
    (id: PaneId, entry: Entry) => {
      const tab = activeTab(usePanes.getState(), id);
      if (entry.kind === "dir") {
        const sep = tab.location.path.endsWith("/") ? "" : "/";
        void navigate(id, tab.location.path + sep + entry.name);
        return;
      }
      // 아카이브 파일 — 임시 추출 후 그 폴더로 진입(탐색기처럼 내부 열람).
      if (isArchiveName(entry.name)) {
        void (async () => {
          const r = await commands.fsArchiveOpenForBrowse({ location: tab.location, name: entry.name });
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
        const r = await commands.openPath(childLocation(tab.location, entry.name));
        if (r.status === "error") showToast(`Cannot open ${entry.name} — ${formatErr(r.error)}`);
      })();
    },
    [navigate, navigateTo, showToast],
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
      const entry = tab.entries[tab.cursorIndex];
      if (entry) onActivate(id, entry);
    },
    [onActivate],
  );

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
      const tab = activeTab(s, id);
      const wasSelected = tab.selected.has(entry.name);
      if (!wasSelected) s.setSelected(id, [entry.name]);
      const selectedCount = wasSelected ? tab.selected.size : 1;
      const items = buildEntryMenu({
        paneId: id,
        entry,
        location: tab.location,
        selectedCount,
        onActivate,
        onOpenInOtherPane,
      });
      useContextMenu.getState().openAt(e.clientX, e.clientY, items);
    },
    [onActivate, onOpenInOtherPane],
  );

  /** 빈 영역 우클릭 — 패널 메뉴(새 폴더/보기/정렬/북마크). */
  const onEmptyContextMenu = useCallback(
    (id: PaneId, e: React.MouseEvent) => {
      e.preventDefault();
      const s = usePanes.getState();
      s.setActivePane(id);
      const tab = activeTab(s, id);
      const items = buildEmptyMenu({ paneId: id, location: tab.location, onRefresh });
      useContextMenu.getState().openAt(e.clientX, e.clientY, items);
    },
    [onRefresh],
  );

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

  const onPickHit = useCallback(
    (hit: SearchHit) => {
      const rootPaneId = useSearch.getState().rootPaneId;
      if (!rootPaneId) return;
      void (async () => {
        await navigate(rootPaneId, hit.location.path);
        const tab = activeTab(usePanes.getState(), rootPaneId);
        const idx = tab.entries.findIndex((e: Entry) => e.name === hit.name);
        if (idx >= 0) usePanes.getState().setCursor(rootPaneId, idx);
        useSearch.getState().close();
      })();
    },
    [navigate],
  );

  useKeyboardNav(onKeyboardActivate, onUp);
  useGlobalShortcuts();
  useSshHosts();
  useConnectionEvents();
  useFsChangedEvents(onRefresh);
  useDestructiveKeys();
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

  useEffect(() => {
    const builtins = buildBuiltins({
      openTab: () => usePanes.getState().openTab(usePanes.getState().activePane),
      closeActiveTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        usePanes.getState().closeTab(id, p.activeTabIndex);
      },
      nextTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        usePanes.getState().selectTab(id, (p.activeTabIndex + 1) % p.tabs.length);
      },
      prevTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        usePanes.getState().selectTab(id, (p.activeTabIndex - 1 + p.tabs.length) % p.tabs.length);
      },
      back: () => onBack(usePanes.getState().activePane),
      forward: () => onForward(usePanes.getState().activePane),
      refresh: () => onRefresh(usePanes.getState().activePane),
      toggleHidden: () => usePanes.getState().toggleShowHidden(usePanes.getState().activePane),
      toggleSidebar: () => toggleSidebar(),
      togglePreview: () => togglePreview(),
      viewDetails: () => usePanes.getState().setViewMode(usePanes.getState().activePane, "details"),
      viewGrid: () => usePanes.getState().setViewMode(usePanes.getState().activePane, "grid"),
      viewTiles: () => usePanes.getState().setViewMode(usePanes.getState().activePane, "tiles"),
      sortByName: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "name"),
      sortBySize: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "size"),
      sortByMtime: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "mtime"),
      sortByKind: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "kind"),
      sortByExt: () => usePanes.getState().toggleSortKey(usePanes.getState().activePane, "ext"),
      toggleBookmark: () => {
        const id = usePanes.getState().activePane;
        const tab = activeTab(usePanes.getState(), id);
        const existing = findBookmarkId(tab.location);
        if (existing) void removeBookmark(existing);
        else void addBookmark(folderName(tab.location), tab.location);
      },
      focusFilter: () => usePanes.getState().setFilterFocused(usePanes.getState().activePane, true),
      openSearch: () => {
        const id = usePanes.getState().activePane;
        const tab = activeTab(usePanes.getState(), id);
        useSearch.getState().open(id, tab.location);
      },
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
    });
    setBuiltins(builtins);
  }, [setBuiltins, openPalette, toggleSidebar, togglePreview, onBack, onForward, onRefresh, openDialog]);

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
      if (exec.status === "error") showToast(`Compress failed: ${formatErr(exec.error)}`);
    },
    [dialog, closeDialog, showToast],
  );

  const onDeleteConfirm = useCallback(async () => {
    if (dialog.kind !== "delete-confirm" && dialog.kind !== "delete-danger") return;
    const plan = dialog.plan;
    closeDialog();
    const r = await commands.fsDeleteExecute(plan);
    if (r.status === "ok") refreshAffected([plan.source_location]);
    else showToast(`Delete failed: ${formatErr(r.error)}`);
  }, [dialog, closeDialog, refreshAffected, showToast]);

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

  const onBookmarkActivate = useCallback(
    (location: Location) => {
      const id = usePanes.getState().activePane;
      void navigateTo(id, location);
    },
    [navigateTo],
  );

  const onFavoriteActivate = useCallback(
    (fav: HostFavorite) => {
      const activeRecord = useConnections.getState().active;
      const conn = Object.values(activeRecord).find((c) => c.alias === fav.host_alias);
      if (!conn) {
        showToast(`Connect to ${fav.host_alias} first`);
        return;
      }
      const id = usePanes.getState().activePane;
      const location: Location = {
        source: { kind: "ssh", connection_id: conn.id, host_ip: conn.host_ip, user: conn.user },
        path: fav.path,
      };
      void navigateTo(id, location);
    },
    [navigateTo, showToast],
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

  /** 활성 탭 위치를 북마크에 추가 (prompt 없이 폴더명 자동). 이미 있으면 무시. */
  const onAddBookmark = useCallback(() => {
    const id = usePanes.getState().activePane;
    const tab = activeTab(usePanes.getState(), id);
    if (findBookmarkId(tab.location)) return;
    void addBookmark(folderName(tab.location), tab.location);
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

  // 새 연결 다이얼로그 — 호스트 더블클릭 시 alias 가 들어옴, 닫으면 null.
  const [dialogAlias, setDialogAlias] = useState<string | null>(null);
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
      // 초기 경로 후보 우선순위: SFTP canonicalize(".") → "~" → "/"
      // 첫번째 성공한 listDirectory 가 패널에 적용됨.
      const homeRes = await commands.sshHomeDirectory(dto.id);
      const candidates: string[] = [];
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
        showToast(`Connected ${alias}, but list failed:\n${failures.join("\n")}`);
      }
    },
    [listDirectory, showToast],
  );

  // 부트스트랩: 양쪽 패널 초기 로드 (home 디렉토리, Windows 호환) + saved hosts + bookmarks + hostFavorites
  useEffect(() => {
    (async () => {
      const result = await commands.homeDirectory();
      const home = result.status === "ok" ? result.data : "/";
      await navigate("left", home);
      await navigate("right", home);
      void bootstrapSavedHosts();
      void bootstrapBookmarks();
      void bootstrapHostFavorites();
      void bootstrapUserAliases();
    })();
    // navigate가 deps에 들어가면 무한 루프 — 마운트 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>
      <SearchPanel onPickHit={onPickHit} />

      <main className="flex flex-1 min-h-0 gap-1.5 p-1.5">
        <Sidebar
          onHostActivate={onHostActivate}
          onAdHocOpen={onAdHocOpen}
          onSavedActivate={onSavedActivate}
          onBookmarkActivate={onBookmarkActivate}
          onFavoriteActivate={onFavoriteActivate}
          onAddBookmark={onAddBookmark}
          onAddFavorite={onAddFavorite}
        />
        <Pane id="left" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh} onBack={onBack} onForward={onForward} onUp={onUp} onEntryContextMenu={onEntryContextMenu} onEmptyContextMenu={onEmptyContextMenu} />
        <Pane id="right" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh} onBack={onBack} onForward={onForward} onUp={onUp} onEntryContextMenu={onEntryContextMenu} onEmptyContextMenu={onEmptyContextMenu} />
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
