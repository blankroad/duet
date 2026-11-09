import { useCreateEntry } from "@/hooks/useCreateEntry";
import { useEffect, useCallback, useState, useRef } from "react";
import { Pane } from "@/components/pane/Pane";
import { SwapPanesButton } from "@/components/pane/SwapPanesButton";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TasksBar } from "@/components/TasksBar";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { AdHocConnectDialog } from "@/components/connection/AdHocConnectDialog";
import type { ReconnectInfo } from "@/components/connection/ReconnectTarget";
import {
  pruneDeadConnections,
  quickReconnect,
  rebindHostTabs,
  type QuickReconnectResult,
  type SshSource,
} from "@/stores/reconnect";
import { BatchRenameDialog } from "@/components/dialogs/BatchRenameDialog";
import { CompareDialog } from "@/components/dialogs/CompareDialog";
import { CompareScanningDialog } from "@/components/dialogs/CompareScanningDialog";
import { ThreeWayDialog } from "@/components/dialogs/ThreeWayDialog";
import { SyncDialog } from "@/components/dialogs/SyncDialog";
import { NewEntryDialog } from "@/components/dialogs/NewEntryDialog";
import { CompressDialog } from "@/components/dialogs/CompressDialog";
import { ChecksumDialog } from "@/components/dialogs/ChecksumDialog";
import { PermissionsDialog } from "@/components/dialogs/PermissionsDialog";
import { SymlinkDialog } from "@/components/dialogs/SymlinkDialog";
import { PasswordPromptDialog } from "@/components/dialogs/PasswordPromptDialog";
import { ArgsDialog } from "@/components/dialogs/ArgsDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { CopyMoveConfirmDialog } from "@/components/dialogs/CopyMoveConfirmDialog";
import { DeletePermanentDialog } from "@/components/dialogs/DeletePermanentDialog";
import { TrashPurgeDialog } from "@/components/dialogs/TrashPurgeDialog";
import { DeleteTrashDialog } from "@/components/dialogs/DeleteTrashDialog";
import { SudoPasswordDialog } from "@/components/dialogs/SudoPasswordDialog";
import {
  rememberElevatable,
  elevatableDestPath,
  type ElevatablePlan,
} from "@/lib/elevatePending";
import { rememberExtract } from "@/lib/extractPending";
import { ProgressModal } from "@/components/dialogs/ProgressModal";
import { ShortcutCheatsheet } from "@/components/dialogs/ShortcutCheatsheet";
import { HistoryDialog } from "@/components/dialogs/HistoryDialog";
import { PromptDialogHost } from "@/components/dialogs/PromptDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Toast } from "@/components/Toast";
import { SearchPanel } from "@/components/SearchPanel";
import { WorkspaceLayout } from "@/components/WorkspaceLayout";
import { QuickLook } from "@/components/pane/QuickLook";
import { TopBar } from "@/components/TopBar";
import { DragGhost } from "@/components/pane/DragGhost";
import { CommandPalette } from "@/components/CommandPalette";
import { FrecencyJumper } from "@/components/FrecencyJumper";
import { useFrecency } from "@/stores/frecency";
import { ContextMenu } from "@/components/ContextMenu";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { openShellMenu } from "@/lib/shellMenu";
import { buildEntryMenu, buildEmptyMenu, folderName } from "@/lib/entryMenu";
import { calcDirSizes } from "@/lib/dirSize";
import { beginTabNav, peekTabNav } from "@/lib/tabNav";
import { toggleDropTray } from "@/lib/dropTray";
import {
  childLocation,
  parentPath,
  parentLocation,
  sameLocation,
  sameLocationDir,
} from "@/lib/entryDnd";
import { canExtractArchive } from "@/lib/archive";
import { basename } from "@/lib/paths";
import { useBookmarks } from "@/stores/bookmarks";
import { useHostFavorites } from "@/stores/hostFavorites";
import {
  resolveActiveTargets,
  triggerCompare,
  triggerSync,
  triggerThreeWay,
  triggerCopy,
  triggerMove,
  triggerDelete,
  triggerMkdir,
  triggerNewFile,
  triggerRenameSmart,
  triggerUndo,
  triggerRedo,
  copySelectionPaths,
  copySelectionNames,
  clipCopy,
  clipCut,
  clipPaste,
  addSelectionToShelf,
  applyShelfTo,
  executeTransfer,
} from "@/lib/fileActions";
import { useCommands } from "@/stores/commands";
import { usePalette } from "@/stores/palette";
import { buildBuiltins } from "@/lib/commands";
import { useUI } from "@/stores/ui";
import { useShelf } from "@/stores/shelf";
import { useAppSettings, syncAppSettings } from "@/stores/settings";
import { useVault } from "@/stores/vault";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  isParentEntry,
  isRestoredRemote,
  applyTabDefaults,
  type PaneId,
  type SortKey,
  type ViewMode,
} from "@/stores/panes";
import { applyTheme } from "@/lib/theme";
import { useSearch } from "@/stores/search";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { bootstrapSavedHosts, useSavedHosts } from "@/stores/savedHosts";
import {
  bootstrapBookmarks,
  addBookmark,
  removeBookmark,
  findBookmarkId,
} from "@/stores/bookmarks";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import { bootstrapHostFavorites } from "@/stores/hostFavorites";
import { bootstrapUserAliases } from "@/stores/userAliases";
import { bootstrapAppLaunchers, setAppArgs } from "@/stores/appLaunchers";
import { bootstrapPlaces, refreshVolumes } from "@/stores/places";
import { recordRecent } from "@/stores/recents";
import { loadSession, initSessionPersist } from "@/stores/session";
import { bootstrapHostGroups } from "@/stores/sidebarGroups";
import { bootstrapHostNicknames } from "@/stores/hostNicknames";
import { bootstrapTags } from "@/stores/tags";
import { useDynamicCommands } from "@/lib/dynamicCommands";
import { useConnections } from "@/stores/connections";
import { useTauri } from "@/hooks/useTauri";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useSshHosts } from "@/hooks/useSshHosts";
import { useConnectionEvents } from "@/hooks/useConnectionEvents";
import { useFsChangedEvents } from "@/hooks/useFsChangedEvents";
import { useOpenPathEvents } from "@/hooks/useOpenPathEvents";
import { useOsFileDrop } from "@/hooks/useOsFileDrop";
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { useArchiveNoticeEvents } from "@/hooks/useArchiveNoticeEvents";
import { useKeymapEvents } from "@/hooks/useKeymapEvents";
import { useStartupNotices } from "@/hooks/useStartupNotices";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { useShellWarm } from "@/hooks/useShellWarm";
import { useIndexProgressEvents } from "@/hooks/useIndexProgressEvents";
import i18n from "@/i18n";
import { Trans } from "react-i18next";
import { explainError, formatErr } from "@/lib/error";
import {
  aliasFromConnectionId,
  findSavedHostForAlias,
  prefillFromAlias,
} from "@/lib/hostAlias";
import { platform } from "@tauri-apps/plugin-os";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { commands } from "@/types/bindings";
import { isVirtualTrash, loadTrashEntries, trashIdsFor } from "@/lib/trashView";
import { useSidebarFilter } from "@/stores/sidebarFilter";
import type {
  CompressFormat,
  ConnectionDto,
  CopyPlan,
  MovePlan,
  Entry,
  EntryRef,
  HostFavorite,
  ConflictPolicy,
  Location,
  SavedHost,
  SearchHit,
  ShellScope,
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
/**
 * 연결 성공 후 갈 곳 — 호스트-인식 북마크/즐겨찾기/배너 재연결.
 * `tabId` 가 있으면(배너 재연결) 그 **탭**으로 돌아간다.
 */
interface ConnectNav {
  alias: string;
  path: string;
  pane: PaneId;
  tabId?: string;
}

/** 탭 id 로 탭 찾기 — 재연결 중 사용자가 탭을 반대 패널로 옮겼을 수 있다. */
function findTab(tabId: string): { pane: PaneId; index: number } | null {
  const { panes } = usePanes.getState();
  for (const pane of ["left", "right"] as const) {
    const index = panes[pane].tabs.findIndex((t) => t.id === tabId);
    if (index >= 0) return { pane, index };
  }
  return null;
}

function App() {
  const { call: listDirectory } = useTauri("listDirectory");
  const showToast = useToast((s) => s.show);

  /** 목록 로드 — 가상 휴지통(Windows Recycle Bin)은 경로가 아니라 trash 목록에서. */
  const listEntries = useCallback(
    (location: Location) =>
      isVirtualTrash(location) ? loadTrashEntries() : listDirectory(location),
    [listDirectory],
  );

  /** 이 위치의 호스트 alias (로컬이면 null) — 살아있는 연결 우선, 없으면 id 접두. */
  const aliasOf = (loc: Location): string | null => {
    if (loc.source.kind !== "ssh") return null;
    const id = loc.source.connection_id;
    return (
      useConnections.getState().active[id]?.alias ?? aliasFromConnectionId(id)
    );
  };

  const navigate = useCallback(
    async (
      id: PaneId,
      path: string,
      opts: {
        pushHistory?: boolean;
        focusName?: string;
        /** 같은 폴더 다시 읽기 — 진행 중인 이동을 무효화하지 않는다 (tabNav). */
        refresh?: boolean;
      } = {},
    ) => {
      const state = usePanes.getState();
      const from = activeTab(state, id);
      const location = { ...from.location, path };
      // 요청한 탭 — 응답이 올 때 그 탭이 닫혔거나 다른 탭이 활성이어도 남의 탭을
      // 덮어쓰지 않게 id 로 대상을 고정한다.
      const tabId = from.id;
      // 로드 중 표시 — 느린 SSH ls 에서 이전 목록이 그대로 보여 "무반응"으로
      // 오인되는 것 방지. setEntries 가 성공 시 자동 해제.
      state.setLoading(id, true, tabId);
      // 같은 탭의 더 새 이동이 이기게. 새로고침은 세대를 올리지 않는다.
      const current = opts.refresh ? peekTabNav(tabId) : beginTabNav(tabId);
      try {
        const entries = await listEntries(location);
        if (!current()) return; // 이 탭에서 더 새 이동이 시작됨
        // 새로고침 응답은 그 탭이 아직 그 폴더일 때만 — 그사이 끝난 이동을
        // 옛 폴더 목록으로 되돌리지 않게.
        const now = usePanes
          .getState()
          .panes[id].tabs.find((t) => t.id === tabId);
        if (opts.refresh && (!now || !sameLocation(now.location, location)))
          return;
        state.setEntries(id, location, entries, {
          tabId,
          pushHistory: opts.pushHistory ?? true,
          ...(opts.focusName !== undefined
            ? { focusName: opts.focusName }
            : {}),
        });
        // navigate 성공 후 watcher 갱신. 실패는 silent — fs:changed 알림 안 옴
        // 정도의 영향. (사용자가 명시 새로고침으로 우회 가능.) 감시자는 패널당
        // 하나 — 그 탭이 지금 보이는 탭일 때만 옮긴다 (숨은 탭의 늦은 이동 제외).
        const p = usePanes.getState().panes[id];
        if (!isVirtualTrash(location) && p.tabs[p.activeTabIndex]?.id === tabId)
          void commands.paneWatchSet(id, location);
        if (opts.pushHistory !== false) {
          if (!isVirtualTrash(location)) {
            recordRecent(location);
            // alias 를 함께 넘긴다 — 재접속해도 같은 항목으로 합쳐지고, 점퍼가
            // 그 alias 로 다시 연결할 수 있다.
            void commands.frecencyRecord(location, aliasOf(location)); // 점퍼(Ctrl+J) 랭킹용
          }
        }
      } catch (e) {
        if (!current()) return; // 낡은 요청의 실패는 무시
        usePanes.getState().setLoading(id, false, tabId);
        // 사용자가 더블클릭해도 silent fail 면 무반응으로 인식. toast 로 노출.
        showToast(
          i18n.t("toast.cannotOpen", { name: path, err: formatErr(e) }),
          "error",
        );
      }
    },
    [listEntries, showToast],
  );

  /** location 전체를 받아 해당 패널을 이동 — Bookmark(SSH 포함) 에서 사용. */
  const navigateTo = useCallback(
    async (
      id: PaneId,
      location: Location,
      /**
       * `tabId`: 이동할 탭 (긴 작업 전에 잡아 둔 탭). 생략하면 지금 활성 탭.
       * `current`: 그 긴 작업을 시작할 때 받은 토큰 — 그사이 같은 탭이 다른 데로
       * 갔으면 이 이동은 하지 않는다.
       */
      opts: {
        pushHistory?: boolean;
        tabId?: string;
        current?: () => boolean;
        /** 뒤로/앞으로 — 성공하면 히스토리 index 를 이 칸으로 확정 (browse-23). */
        historyIndex?: number;
      } = {},
    ): Promise<boolean> => {
      const tabId = opts.tabId ?? activeTab(usePanes.getState(), id).id;
      // 대상 탭이 이미 닫혔거나 사용자가 그 탭에서 더 새로 이동했으면 시작하지 않는다
      // (닫힌 탭의 늦은 작업이 남은 탭의 로드를 방해하지 않게).
      if (!usePanes.getState().panes[id].tabs.some((t) => t.id === tabId))
        return false;
      if (opts.current && !opts.current()) return false;
      usePanes.getState().setLoading(id, true, tabId);
      const current = beginTabNav(tabId);
      try {
        const entries = await listEntries(location);
        if (!current()) return false;
        usePanes.getState().setEntries(id, location, entries, {
          tabId,
          pushHistory: opts.pushHistory ?? true,
          ...(opts.historyIndex !== undefined
            ? { historyIndex: opts.historyIndex }
            : {}),
        });
        // 그 탭이 닫혔으면 아무것도 적용되지 않았다.
        const p = usePanes.getState().panes[id];
        if (!p.tabs.some((t) => t.id === tabId)) return false;
        // 감시자는 패널당 하나 — 그 탭이 지금 보이는 탭일 때만 옮긴다.
        if (!isVirtualTrash(location) && p.tabs[p.activeTabIndex]?.id === tabId)
          void commands.paneWatchSet(id, location);
        if (opts.pushHistory !== false) {
          if (!isVirtualTrash(location)) {
            recordRecent(location);
            // alias 를 함께 넘긴다 — 재접속해도 같은 항목으로 합쳐지고, 점퍼가
            // 그 alias 로 다시 연결할 수 있다.
            void commands.frecencyRecord(location, aliasOf(location)); // 점퍼(Ctrl+J) 랭킹용
          }
        }
        return true;
      } catch (e) {
        if (!current()) return false;
        usePanes.getState().setLoading(id, false, tabId);
        showToast(
          i18n.t("toast.cannotOpen", {
            name: location.path,
            err: formatErr(e),
          }),
          "error",
        );
        return false;
      }
    },
    [listEntries, showToast],
  );

  /** 로컬/SSH location 을 지정 패널로 이동 — 사이드바 Places/Volumes/Recent/Bookmarks 공용. */
  const onOpenLocation = useCallback(
    (location: Location, pane: PaneId) => void navigateTo(pane, location),
    [navigateTo],
  );

  /**
   * 동기화 브라우징 — 활성 패널의 폴더 진입/위로를 반대 패널(opposite)에 동행.
   * setEntries 직접 호출(navigate 우회)이라 재진입/무한루프 없음. 대응 경로가 없거나
   * 권한 실패면 조용히 무시(토스트 X) — 반대 패널은 그대로 둔다.
   */
  const syncMirror = useCallback(
    (opposite: PaneId, target: Location) => {
      // 반대 패널의 지금 탭에 고정 — 목록이 오는 사이 그쪽 탭을 바꾸거나 닫아도 남의
      // 탭을 덮어쓰지 않게. 그 탭에서 더 새 이동이 시작되면 이 동행은 버린다.
      const tabId = activeTab(usePanes.getState(), opposite).id;
      const current = beginTabNav(tabId);
      void (async () => {
        try {
          const entries = await listEntries(target);
          if (!current()) return;
          usePanes.getState().setEntries(opposite, target, entries, {
            pushHistory: true,
            tabId,
          });
          const p = usePanes.getState().panes[opposite];
          if (p.tabs[p.activeTabIndex]?.id === tabId)
            void commands.paneWatchSet(opposite, target);
        } catch {
          /* 반대편에 대응 경로 없음 — 동행 skip */
        }
      })();
    },
    [listEntries],
  );

  /** 활성 패널을 그 소스의 휴지통으로 이동 — 삭제 항목 보기/복구(복사·이동으로). */
  const onTrashActivate = useCallback(
    (pane?: PaneId) => {
      const id = pane ?? usePanes.getState().activePane;
      const startTab = activeTab(usePanes.getState(), id);
      const src = startTab.location.source;
      const current = beginTabNav(startTab.id);
      void (async () => {
        // Windows 로컬은 backend 가 가상 location(shell:RecycleBinFolder)을 반환 —
        // navigateTo(listEntries)가 trash 목록으로 채운다.
        const r = await commands.trashLocation(src);
        if (r.status === "error") {
          if (current()) usePanes.getState().setLoading(id, false, startTab.id);
          showToast(
            i18n.t("toast.trashUnavailable", { err: formatErr(r.error) }),
            "error",
          );
          return;
        }
        // 휴지통 위치를 묻는 사이 탭을 바꿔도 시작한 탭이 휴지통이 된다.
        if (await navigateTo(id, r.data, { tabId: startTab.id, current }))
          usePanes.getState().setTrashRoot(id, r.data.path, startTab.id);
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
      const tab = activeTab(usePanes.getState(), id);
      // 가상 휴지통(Windows) — id 로 일괄 복원.
      if (isVirtualTrash(tab.location)) {
        const ids = trashIdsFor(targets.map((t) => t.name));
        const r = await commands.trashPutBack(ids);
        if (r.status === "error") {
          showToast(
            i18n.t("toast.putBackFailed", { err: formatErr(r.error) }),
            "error",
          );
          return;
        }
        await navigateTo(id, tab.location, { pushHistory: false });
        showToast(
          i18n.t("toast.putBackDone", { count: ids.length }),
          "success",
        );
        return;
      }
      let ok = 0;
      for (const t of targets) {
        const r = await commands.trashRestore(t);
        if (r.status === "ok") ok += 1;
        else
          showToast(
            i18n.t("toast.putBackFailed", { err: formatErr(r.error) }),
            "error",
          );
      }
      if (ok > 0) {
        const loc = activeTab(usePanes.getState(), id).location;
        await navigateTo(id, loc, { pushHistory: false });
        showToast(i18n.t("toast.putBackDone", { count: ok }), "success");
      }
    })();
  }, [navigateTo, showToast]);

  /** 가상 휴지통 영구 삭제/비우기 — 성공 시 휴지통 뷰 새로고침. */
  const onTrashPurgeConfirm = useCallback(
    async (word: string) => {
      const dlg = useUIDialogs.getState().dialog;
      if (dlg.kind !== "trash-purge") return;
      useUIDialogs.getState().close();
      const r = dlg.all
        ? await commands.trashEmpty(word)
        : await commands.trashPurge(trashIdsFor(dlg.names), word);
      if (r.status === "error") {
        showToast(
          i18n.t("toast.purgeFailed", { err: formatErr(r.error) }),
          "error",
        );
        return;
      }
      showToast(i18n.t("toast.purgeDone", { count: r.data }), "success");
      const id = usePanes.getState().activePane;
      const tab = activeTab(usePanes.getState(), id);
      if (isVirtualTrash(tab.location))
        await navigateTo(id, tab.location, { pushHistory: false });
    },
    [navigateTo, showToast],
  );

  const onUp = useCallback(
    (id: PaneId) => {
      const tab = activeTab(usePanes.getState(), id);
      // 아카이브 임시 루트에서 "위로" = 아카이브 빠져나가 원래 폴더로.
      if (tab.archive && tab.location.path === tab.archive.root) {
        void navigateTo(id, tab.archive.exitTo);
        return;
      }
      // 부모 경로 — Windows(C:\)·POSIX·혼합 구분자 모두 처리(parentPath). 루트면 멈춤.
      const parent = parentPath(tab.location.path);
      if (parent === null) return;
      // 떠나온 폴더에 커서를 놓는다 — 형제 폴더를 오갈 때 매번 커서를 다시 찾지 않게.
      void navigate(id, parent, { focusName: basename(tab.location.path) });
      // 동기화 브라우징 — 반대 패널도 한 단계 위로(아카이브/휴지통 컨텍스트면 skip).
      if (useUI.getState().syncBrowse && !tab.archive && !tab.trashRoot) {
        const opp: PaneId = id === "left" ? "right" : "left";
        const oppTab = activeTab(usePanes.getState(), opp);
        const oppParent = parentLocation(oppTab.location);
        if (oppParent && !oppTab.archive) syncMirror(opp, oppParent);
      }
    },
    [navigate, navigateTo, syncMirror],
  );

  const onActivate = useCallback(
    (id: PaneId, entry: Entry) => {
      const tab = activeTab(usePanes.getState(), id);
      // ".." 부모 행 — 위로(또는 아카이브 나가기).
      if (entry.name === "..") {
        onUp(id);
        return;
      }
      // 가상 휴지통 — 실제 경로가 아니라 열 수 없음. 복원 후 열도록 안내.
      if (isVirtualTrash(tab.location)) {
        showToast(i18n.t("toast.trashOpenHint"));
        return;
      }
      if (entry.kind === "dir") {
        // 경로 결합은 childLocation 으로 — Windows 드라이브 루트에서 C:\/ 중복 방지.
        void navigate(id, childLocation(tab.location, entry.name).path);
        // 동기화 브라우징 — 반대 패널도 같은 이름 하위폴더로(있으면).
        if (useUI.getState().syncBrowse && !tab.archive && !tab.trashRoot) {
          const opp: PaneId = id === "left" ? "right" : "left";
          const oppTab = activeTab(usePanes.getState(), opp);
          if (!oppTab.archive)
            syncMirror(opp, childLocation(oppTab.location, entry.name));
        }
        return;
      }
      // 아카이브 파일 — 임시 추출 후 그 폴더로 진입(탐색기처럼 내부 열람).
      // 원격에서 못 푸는 포맷(7z/rar/단일 파일)은 아래 일반 파일 열기로 넘어간다.
      if (canExtractArchive(entry.name, tab.location.source)) {
        const archive = { location: tab.location, name: entry.name };
        // 추출 동안 이 탭에서 다른 데로 가면 늦게 끝난 추출이 그 위치를 덮지 않게.
        const current = beginTabNav(tab.id);
        void (async () => {
          // 1차는 암호 없이 — 암호 zip 이면 NeedPassword → 암호 입력 다이얼로그.
          const r = await commands.fsArchiveOpenForBrowse(archive, null);
          if (r.status === "error") {
            // 이 열기가 앞선 이동을 대체했으니 그 로딩 표시를 이 작업이 끝낸다 (더
            // 새 이동이 있으면 그쪽 몫).
            if (current()) usePanes.getState().setLoading(id, false, tab.id);
            if (r.error.kind === "NeedPassword") {
              useUIDialogs.getState().open({
                kind: "browse-password",
                paneId: id,
                archive,
                tabId: tab.id,
              });
              return;
            }
            const why = explainError(r.error);
            showToast(
              i18n.t("toast.cannotOpen", { name: entry.name, err: why.text }),
              "error",
              { detail: why.detail },
            );
            return;
          }
          // 추출은 오래 걸린다 — 그 사이 탭을 바꿔도 목록과 아카이브 문맥이 같은
          // 탭(시작한 탭)에 붙게 한다. 예전엔 목록과 문맥이 서로 다른 탭에 붙었다.
          if (await navigateTo(id, r.data, { tabId: tab.id, current }))
            usePanes
              .getState()
              .setArchiveContext(
                id,
                { label: entry.name, root: r.data.path, exitTo: tab.location },
                tab.id,
              );
        })();
        return;
      }
      // 일반 파일 — OS 기본 앱으로 열기 (원격은 backend 가 temp 다운로드 후 열기).
      void (async () => {
        const r = await commands.openPath(
          childLocation(tab.location, entry.name),
          false,
        );
        if (r.status === "error")
          showToast(
            i18n.t("toast.cannotOpen", {
              name: entry.name,
              err: formatErr(r.error),
            }),
            "error",
          );
      })();
    },
    [navigate, navigateTo, onUp, showToast, syncMirror],
  );

  const onRefresh = useCallback(
    (id: PaneId) => {
      const tab = activeTab(usePanes.getState(), id);
      // 복원된(아직 연결 안 된) 원격 탭은 읽을 연결이 없다 — 죽은 id 로 IPC 를 보내
      // 오류 토스트만 뜨던 것을 막는다. 패널 배너의 "재연결"이 그 경로로 연다.
      if (isRestoredRemote(tab.location)) return;
      // 새로고침은 같은 위치 재로드 — 히스토리(뒤로가기) 에 중복 push 하지 않음.
      navigate(id, tab.location.path, { pushHistory: false, refresh: true });
    },
    [navigate],
  );

  /**
   * 탭 전환 시 그 탭 폴더를 다시 읽고 백엔드 감시자도 그 경로로 옮긴다.
   *
   * `selectTab` 은 순수 store 액션이라, 전환해 온 탭은 예전 목록을 그대로 보여 주고
   * (그 사이 다른 탭에서 만든 파일이 안 보였다) `pane_watch_set` 은 마지막 navigate
   * 경로에 머물러 그 탭에서는 자동 새로고침이 아예 오지 않았다.
   *
   * 인덱스가 아니라 **탭 id** 를 본다 — 0번 활성 탭을 닫거나 "다른 탭 모두 닫기"·
   * 반대 패널로 이동·패널 교환처럼 번호는 그대로인 채 보이는 탭이 바뀌는 경우를
   * 번호로는 놓쳤다.
   */
  const leftTab = usePanes((s) => activeTab(s, "left").id);
  const rightTab = usePanes((s) => activeTab(s, "right").id);
  const prevTabIdx = useRef({ left: leftTab, right: rightTab });
  useEffect(() => {
    for (const id of ["left", "right"] as const) {
      const now = id === "left" ? leftTab : rightTab;
      if (prevTabIdx.current[id] === now) continue; // 마운트/무관한 렌더
      prevTabIdx.current[id] = now;
      onRefresh(id);
    }
  }, [leftTab, rightTab, onRefresh]);

  /**
   * 커서가 폴더면 그 폴더, 아니면 현재 폴더의 Location — "반대 패널에서 열기" 와
   * "새 탭에서 열기" 가 공유한다(TC 의 Ctrl+←/→, Ctrl+↑ 자리).
   */
  const cursorFolderLocation = useCallback((id: PaneId): Location => {
    const tab = activeTab(usePanes.getState(), id);
    const entry = computeDisplayed(tab)[tab.cursorIndex];
    if (entry && entry.kind === "dir" && !isParentEntry(entry))
      return childLocation(tab.location, entry.name);
    return tab.location;
  }, []);

  /**
   * 탭별로 진행 중인 뒤로/앞으로가 향하는 히스토리 칸 — 느린 SSH 에서 연타하면
   * 확정 전 칸에서 한 칸 더 간다. `current` 가 false 면 다른 이동이 끼어든 것.
   */
  const pendingHistory = useRef(
    new Map<string, { index: number; current: () => boolean }>(),
  );

  /**
   * 뒤로(-1)/앞으로(+1) — 히스토리의 **전체 Location**(소스 포함)으로 이동하고,
   * 성공했을 때만 index 를 옮긴다 (browse-05·browse-23).
   */
  const stepHistory = useCallback(
    (id: PaneId, delta: -1 | 1) => {
      const s = usePanes.getState();
      const pending = pendingHistory.current.get(activeTab(s, id).id);
      const from = pending?.current() ? pending.index : undefined;
      const step = s.peekHistory(id, delta, from);
      if (!step) return;
      const done = navigateTo(id, step.location, {
        tabId: step.tabId,
        pushHistory: false,
        historyIndex: step.index,
      });
      // navigateTo 는 첫 await 전에 이 탭의 이동 세대를 올린다 — 그 세대를 엿본다.
      const mine = { index: step.index, current: peekTabNav(step.tabId) };
      pendingHistory.current.set(step.tabId, mine);
      void done.finally(() => {
        if (pendingHistory.current.get(step.tabId) === mine)
          pendingHistory.current.delete(step.tabId);
      });
    },
    [navigateTo],
  );

  const onBack = useCallback(
    (id: PaneId) => stepHistory(id, -1),
    [stepHistory],
  );

  const onForward = useCallback(
    (id: PaneId) => stepHistory(id, 1),
    [stepHistory],
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

  /** 엔트리 컨텍스트 메뉴를 (cx, cy) 좌표에 오픈 — 마우스 우클릭과 키보드가 공유. */
  const openEntryMenuAt = useCallback(
    (id: PaneId, entry: Entry, index: number, cx: number, cy: number) => {
      const s = usePanes.getState();
      s.setActivePane(id);
      s.setCursor(id, index);
      // ".." 부모 행 — 상위 폴더 열기 / 상위 경로 복사 (파일 작업 메뉴는 없음).
      if (entry.name === "..") {
        const par = parentLocation(activeTab(s, id).location);
        const parentItems: MenuEntry[] = [
          {
            id: "up",
            label: i18n.t("menu.openParent"),
            onSelect: () => onUp(id),
          },
        ];
        if (par) {
          parentItems.push({
            id: "copy-parent-path",
            label: i18n.t("menu.copyParentPath"),
            onSelect: () => {
              // forward-slash 통일(D:/test/test1) — copyPathsOf 와 동일.
              void navigator.clipboard
                .writeText(String(par.path).replace(/\\/g, "/"))
                .then(() =>
                  showToast(
                    i18n.t("toast.copiedLabel", {
                      label: i18n.t("toast.labelPath").toLowerCase(),
                    }),
                    "success",
                  ),
                )
                .catch(() =>
                  showToast(i18n.t("toast.clipboardUnavailable"), "error"),
                );
            },
          });
        }
        useContextMenu.getState().openAt(cx, cy, parentItems);
        return;
      }
      const tab = activeTab(s, id);
      const wasSelected = tab.selected.has(entry.name);
      if (!wasSelected) s.setSelected(id, [entry.name]);
      const selectedCount = wasSelected ? tab.selected.size : 1;
      // duet 메뉴를 *즉시* 연다(셸 메뉴 빌드를 안 기다림 — 우클릭 지연 제거).
      const items = buildEntryMenu({
        paneId: id,
        entry,
        location: tab.location,
        selectedCount,
        inTrash: tab.trashRoot !== undefined,
        inVirtualTrash: isVirtualTrash(tab.location),
        onActivate,
        onOpenInOtherPane,
        onPutBack,
      });
      // Windows 로컬 단일 선택: 실제 셸 메뉴(Tier 2)를 "More options ▸" 지연 항목으로.
      // 펼칠 때만 조회 → 메뉴가 갑자기 커지지도 않음(Win11 방식).
      if (
        platform() === "windows" &&
        tab.location.source.kind === "local" &&
        selectedCount === 1
      ) {
        const child = childLocation(tab.location, entry.name);
        const scope: ShellScope = entry.kind === "dir" ? "directory" : "file";
        // 커서-멈춤 예열(useShellWarm)이 이미 캐시해 뒀으면 백엔드가 즉시 서빙, 아니면
        // 그때 빌드. 세션 수명은 백엔드 캐시가 관리 — FE close 불필요.
        const shellPromise = openShellMenu(String(child.path), scope);
        items.push(
          { kind: "separator" },
          {
            id: "win-more",
            label: i18n.t("menu.moreOptions"),
            loadChildren: async () => {
              const shell = await shellPromise;
              return shell ? shell.entries : [];
            },
          },
        );
      }
      useContextMenu.getState().openAt(cx, cy, items);
    },
    [onActivate, onOpenInOtherPane, onPutBack, onUp, showToast],
  );

  /** 엔트리 우클릭 — 활성 패널/cursor/선택을 맞춘 뒤(Finder 관례) 컨텍스트 메뉴 오픈. */
  const onEntryContextMenu = useCallback(
    (id: PaneId, entry: Entry, index: number, e: React.MouseEvent) => {
      e.preventDefault();
      openEntryMenuAt(id, entry, index, e.clientX, e.clientY);
    },
    [openEntryMenuAt],
  );

  /** 빈 영역 컨텍스트 메뉴를 (cx, cy) 좌표에 오픈 — 마우스/키보드 공유. */
  const openEmptyMenuAt = useCallback(
    (id: PaneId, cx: number, cy: number) => {
      const s = usePanes.getState();
      s.setActivePane(id);
      const tab = activeTab(s, id);
      // duet 메뉴를 *즉시* 연다(셸 메뉴 빌드를 안 기다림).
      const items = buildEmptyMenu({
        paneId: id,
        location: tab.location,
        onRefresh,
        inVirtualTrash: isVirtualTrash(tab.location),
      });
      // Windows 로컬: 배경(빈 영역) 셸 메뉴를 "More options ▸" 지연 항목으로(펼칠 때만 조회).
      if (
        platform() === "windows" &&
        tab.location.source.kind === "local" &&
        !isVirtualTrash(tab.location)
      ) {
        const bgPath = String(tab.location.path);
        // 캐시 있으면 백엔드가 즉시 서빙, 아니면 그때 빌드. 세션 수명은 백엔드 캐시가 관리.
        const shellPromise = openShellMenu(bgPath, "background");
        items.push(
          { kind: "separator" },
          {
            id: "win-more",
            label: i18n.t("menu.moreOptions"),
            loadChildren: async () => {
              const shell = await shellPromise;
              return shell ? shell.entries : [];
            },
          },
        );
      }
      useContextMenu.getState().openAt(cx, cy, items);
    },
    [onRefresh],
  );

  /** 빈 영역 우클릭 — 패널 메뉴(새 폴더/보기/정렬/북마크). */
  const onEmptyContextMenu = useCallback(
    (id: PaneId, e: React.MouseEvent) => {
      e.preventDefault();
      openEmptyMenuAt(id, e.clientX, e.clientY);
    },
    [openEmptyMenuAt],
  );

  /**
   * Shift+F10 (file.contextMenu) — 활성 패널 커서 항목의 컨텍스트 메뉴를 키보드로.
   * 위치는 커서 행 DOM rect 에서 계산(가상 스크롤이 커서를 항상 뷰포트에 유지).
   * 커서 항목이 없으면(빈 폴더) 패널 좌상단에 빈 영역 메뉴.
   */
  const openContextMenuAtCursor = useCallback(() => {
    const s = usePanes.getState();
    const id = s.activePane;
    const tab = activeTab(s, id);
    const entry = computeDisplayed(tab)[tab.cursorIndex];
    const paneEl = document.querySelector(`[data-drop-pane="${id}"]`);
    const paneRect = paneEl?.getBoundingClientRect();
    const fallbackX = (paneRect?.left ?? 0) + 24;
    const fallbackY = (paneRect?.top ?? 0) + 24;
    if (entry) {
      const rowEl = paneEl?.querySelector(
        `[data-entry="${CSS.escape(entry.name)}"]`,
      );
      const r = rowEl?.getBoundingClientRect();
      openEntryMenuAt(
        id,
        entry,
        tab.cursorIndex,
        r ? r.left + 16 : fallbackX,
        r ? r.bottom : fallbackY,
      );
    } else {
      openEmptyMenuAt(id, fallbackX, fallbackY);
    }
  }, [openEntryMenuAt, openEmptyMenuAt]);

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
  useOpenPathEvents(navigate);
  useOsFileDrop();
  useJournalEvents();
  useArchiveNoticeEvents();
  useKeymapEvents();
  useStartupNotices();
  useIndexProgressEvents();

  const dialog = useUIDialogs((s) => s.dialog);
  const closeDialog = useUIDialogs((s) => s.close);
  const openDialog = useUIDialogs((s) => s.open);

  /**
   * 영향받은 location 들이 현재 패널과 같은 디렉토리면 refresh.
   * 동기 command (mkdir/rename/새 파일 등) 직후 호출. task 기반 작업은 백엔드
   * fs:changed 로 새로고침되므로 여기서 다루지 않음. 비교는 분리자 무관 정규화.
   */
  const refreshAffected = useCallback(
    (locations: Location[], skipTabId?: string) => {
      const state = usePanes.getState();
      for (const id of ["left", "right"] as const) {
        const tab = activeTab(state, id);
        if (tab.id === skipTabId) continue;
        const loc = tab.location;
        if (locations.some((l) => sameLocationDir(l, loc))) onRefresh(id);
      }
    },
    [onRefresh],
  );

  useTaskEvents();
  useShellWarm();

  const setBuiltins = useCommands((s) => s.setBuiltins);
  // onOpenHostPath 는 아래에서 정의돼 effect deps 에 직접 못 넣는다(TDZ) — ref 로 최신
  // 함수를 잡아 커맨드가 호출한다.
  const openHostPathRef = useRef<
    (alias: string, path: string, pane: PaneId) => void
  >(() => {});
  // 설정이 바뀌면 커맨드 목록을 다시 만든다 — 영구 삭제 노출 여부가 걸려 있다.
  const permanentDeleteEnabled = useAppSettings(
    (s) => s.permanentDeleteEnabled,
  );
  const openPalette = usePalette((s) => s.open);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const togglePreview = useUI((s) => s.togglePreview);
  const quickLookOpen = useUI((s) => s.quickLookOpen);
  // 단일 패널 모드 — 활성 패널만 렌더. 숨긴 쪽 상태는 panes store 에 보존되고
  // Tab(활성 패널 전환)이 곧 "보이는 패널 교체"가 된다.
  const singlePane = useUI((s) => s.singlePane);
  const visiblePane = usePanes((s) => s.activePane);

  useEffect(() => {
    const builtins = buildBuiltins({
      permanentDeleteEnabled,
      // F4 — 커서 파일을 편집기로. 원격은 기존 편집 라운드트립(다운로드→저장 시 재업로드).
      editFile: () => {
        const st = usePanes.getState();
        const id = st.activePane;
        const tab = activeTab(st, id);
        const entry = computeDisplayed(tab)[tab.cursorIndex];
        if (!entry || entry.kind === "dir" || isParentEntry(entry)) {
          showToast(i18n.t("toast.editSelectFile"));
          return;
        }
        const loc = childLocation(tab.location, entry.name);
        void (async () => {
          const r =
            tab.location.source.kind === "ssh"
              ? await commands.sshEditOpen(loc)
              : await commands.openPath(loc, true);
          if (r.status === "error")
            showToast(
              i18n.t("toast.cannotOpen", {
                name: entry.name,
                err: formatErr(r.error),
              }),
              "error",
            );
        })();
      },
      // 커서가 폴더면 그 폴더를, 아니면 현재 폴더를 반대 패널/새 탭에서 연다.
      openInOtherPane: () => {
        const st = usePanes.getState();
        const id = st.activePane;
        const opp: PaneId = id === "left" ? "right" : "left";
        void navigateTo(opp, cursorFolderLocation(id));
        st.setActivePane(opp);
      },
      openInNewTab: () => {
        const st = usePanes.getState();
        const id = st.activePane;
        // 대상 위치로 바로 탭을 만든다 — 목록은 탭 전환 effect 가 읽는다. 예전엔
        // 현재 폴더 복제 탭을 만든 뒤 navigateTo 했는데, effect 의 새로고침이 더 새
        // 요청이 되어 navigateTo 결과가 버려지고 현재 폴더가 열렸다.
        st.openTab(id, cursorFolderLocation(id), {
          after: st.panes[id].activeTabIndex,
        });
      },
      gotoTab: (n) => {
        const st = usePanes.getState();
        const id = st.activePane;
        const p = st.panes[id];
        if (n - 1 < p.tabs.length) st.selectTab(id, n - 1);
      },
      gotoBookmark: (n) => {
        // 사이드바에 보이는 순서 = 로컬 북마크 다음 원격 즐겨찾기.
        const bms = useBookmarks.getState().items;
        const favs = useHostFavorites.getState().items;
        const pane = usePanes.getState().activePane;
        const bm = bms[n - 1];
        if (bm) {
          void onOpenLocation(bm.location, pane);
          return;
        }
        const fav = favs[n - 1 - bms.length];
        if (fav)
          openHostPathRef.current(fav.host_alias, String(fav.path), pane);
      },
      // 호스트만 걸러 보여 주는 팔레트 — 접속이 키보드만으로 끝난다.
      quickConnect: () => usePalette.getState().open("Connect"),
      openTab: () =>
        usePanes.getState().openTab(usePanes.getState().activePane),
      closeActiveTab: () => {
        const id = usePanes.getState().activePane;
        const p = usePanes.getState().panes[id];
        // 고정 탭은 store 가 닫지 않는다 — 무반응 대신 이유를 알린다.
        if (
          !usePanes.getState().closeTab(id, p.activeTabIndex) &&
          p.tabs[p.activeTabIndex]?.pinned
        )
          showToast(i18n.t("tabs.pinnedCannotClose"), "info");
      },
      togglePinTab: () => {
        const st = usePanes.getState();
        st.togglePinTab(st.activePane, st.panes[st.activePane].activeTabIndex);
      },
      reopenClosedTab: () => {
        usePanes.getState().reopenClosedTab();
      },
      moveTabLeft: () => {
        const st = usePanes.getState();
        st.moveTab(st.activePane, st.panes[st.activePane].activeTabIndex, -1);
      },
      moveTabRight: () => {
        const st = usePanes.getState();
        st.moveTab(st.activePane, st.panes[st.activePane].activeTabIndex, 1);
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
      jump: () => useFrecency.getState().open(),
      editPath: () =>
        useUI.getState().requestEditPath(usePanes.getState().activePane),
      refresh: () => onRefresh(usePanes.getState().activePane),
      toggleHidden: () =>
        usePanes.getState().toggleShowHidden(usePanes.getState().activePane),
      toggleSidebar: () => toggleSidebar(),
      focusSidebarFilter: () => useSidebarFilter.getState().requestFocus(),
      togglePreview: () => togglePreview(),
      toggleSyncBrowse: () => useUI.getState().toggleSyncBrowse(),
      toggleSinglePane: () => useUI.getState().toggleSinglePane(),
      toggleDropTray: () => void toggleDropTray(),
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
      selectAll: () => {
        const st = usePanes.getState();
        st.selectAll(st.activePane);
      },
      clearSelection: () => {
        const st = usePanes.getState();
        st.setSelected(st.activePane, []);
      },
      invertSelection: () => {
        const st = usePanes.getState();
        st.invertSelection(st.activePane);
      },
      selectByPattern: () =>
        useUI
          .getState()
          .requestSelectPattern(usePanes.getState().activePane, "add"),
      deselectByPattern: () =>
        useUI
          .getState()
          .requestSelectPattern(usePanes.getState().activePane, "remove"),
      shelfAdd: () => addSelectionToShelf(showToast),
      shelfApplyCopy: () => void applyShelfTo("copy", openDialog, showToast),
      shelfApplyMove: () => void applyShelfTo("move", openDialog, showToast),
      shelfClear: () => useShelf.getState().clear(),
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
      newFile: () => triggerNewFile(openDialog),
      delete: () => void triggerDelete("trash", openDialog, showToast),
      deletePerm: () => void triggerDelete("permanent", openDialog, showToast),
      copyPath: () => void copySelectionPaths(showToast),
      copyName: () => void copySelectionNames(showToast),
      calcDirSize: () => void calcDirSizes(usePanes.getState().activePane),
      clipCopy: () => clipCopy(showToast),
      clipCut: () => clipCut(showToast),
      clipPaste: () => void clipPaste(openDialog, showToast),
      undo: () => void triggerUndo(showToast),
      redo: () => void triggerRedo(showToast),
      openContextMenu: openContextMenuAtCursor,
      openShortcuts: () => openDialog({ kind: "shortcuts" }),
      openHistory: () => openDialog({ kind: "history" }),
      setupKeyAuth: () => {
        const src = activeTab(
          usePanes.getState(),
          usePanes.getState().activePane,
        ).location.source;
        if (src.kind !== "ssh") {
          showToast(i18n.t("toast.notRemoteHost"));
          return;
        }
        void (async () => {
          // window.confirm 은 Tauri 웹뷰에서 동작 안 함 → plugin-dialog 의 native confirm.
          const ok = await tauriConfirm(i18n.t("dialog.keyAuth.confirm"), {
            title: i18n.t("dialog.keyAuth.title"),
          });
          if (!ok) return;
          const r = await commands.sshSetupKeyAuth(src.connection_id);
          showToast(
            r.status === "ok"
              ? i18n.t("toast.keyAuthDone", { path: r.data })
              : i18n.t("toast.keyAuthFailed", { err: formatErr(r.error) }),
            r.status === "ok" ? "success" : "error",
          );
        })();
      },
    });
    setBuiltins(builtins);
  }, [
    setBuiltins,
    permanentDeleteEnabled,
    cursorFolderLocation,
    navigateTo,
    onOpenLocation,
    openPalette,
    toggleSidebar,
    togglePreview,
    onBack,
    onForward,
    onRefresh,
    openDialog,
    showToast,
    openContextMenuAtCursor,
  ]);

  const onBatchRenameSubmit = useCallback(
    async (rule: import("@/types/bindings").RenameRule) => {
      if (dialog.kind !== "batch-rename") return;
      const targets = dialog.targets;
      closeDialog();
      const r = await commands.fsBatchRename(targets, rule);
      if (r.status === "ok") refreshAffected([targets[0]!.location]);
      else
        showToast(
          i18n.t("toast.batchRenameFailed", { err: formatErr(r.error) }),
          "error",
        );
    },
    [dialog, closeDialog, refreshAffected, showToast],
  );

  const onCreateEntrySubmit = useCreateEntry(
    dialog,
    listEntries,
    refreshAffected,
  );

  const onCompressSubmit = useCallback(
    async (name: string, format: CompressFormat) => {
      if (dialog.kind !== "compress") return;
      const items = dialog.items;
      closeDialog();
      const plan = await commands.fsCompressPlan(items, name, format);
      if (plan.status === "error") {
        showToast(
          i18n.t("toast.compressFailed", { err: formatErr(plan.error) }),
          "error",
        );
        return;
      }
      // execute 는 task 로 — 완료 시 affected_locations 자동 새로고침 (useTaskEvents).
      const exec = await commands.fsCompressExecute(plan.data);
      if (exec.status === "error")
        showToast(
          i18n.t("toast.compressFailed", { err: formatErr(exec.error) }),
          "error",
        );
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
          showToast(
            i18n.t("toast.updateArchiveFailed", { err: formatErr(r.error) }),
            "error",
          );
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
        title: i18n.t("dialog.progress.updatingArchive"),
        taskId: r.data,
      });
    } else {
      closeDialog();
      showToast(
        i18n.t("toast.updateArchiveFailed", { err: formatErr(r.error) }),
        "error",
      );
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
      // 방어: onClick 핸들러로 이벤트 객체가 인자로 새어들어오면 ""로 강제 —
      // 그대로 IPC 로 보내면 순환참조 직렬화가 깨져 삭제가 통째로 실패한다.
      const word = typeof confirmWord === "string" ? confirmWord : "";
      // 삭제는 이제 백그라운드 task — 완료 시 useTaskEvents 가 affected_locations 로
      // refresh. 여기선 enqueue 결과만 확인(즉시 refresh 하면 아직 삭제 전이라 stale).
      const r = await commands.fsDeleteExecute(plan, word);
      if (r.status === "ok")
        rememberElevatable(r.data, { op: "delete", plan, confirmWord: word });
      else
        showToast(
          i18n.t("toast.deleteFailed", { err: formatErr(r.error) }),
          "error",
        );
    },
    [dialog, closeDialog, showToast],
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
      showToast(i18n.t("toast.ejected", { name }), "success");
      void refreshVolumes();
    } else {
      showToast(
        i18n.t("toast.ejectFailed", { err: formatErr(r.error) }),
        "error",
      );
    }
  }, [dialog, closeDialog, showToast]);

  const onCopyConfirm = useCallback(
    async (policy: ConflictPolicy) => {
      if (dialog.kind !== "copy-confirm") return;
      // 확인을 건너뛰는 설정에서의 실행과 같은 경로 — 진행 모달은 느릴 때만 뜬다.
      await executeTransfer(
        "copy",
        dialog.plan,
        policy,
        openDialog,
        closeDialog,
        showToast,
      );
    },
    [dialog, openDialog, closeDialog, showToast],
  );

  /**
   * per-file 충돌 해결 실행 — 파일별 결정(Replace/Skip/KeepBoth)을 정책별
   * 그룹으로 나눠 각각 재plan 후 실행. skip 은 제외, 비충돌 항목은 첫 그룹에
   * 합류(작업 수 최소화). 가장 큰 그룹을 ProgressModal 로 표시하고 나머지
   * 그룹의 진행은 TasksBar 에서.
   */
  const onTransferPerFile = useCallback(
    async (
      mode: "copy" | "move",
      plan: CopyPlan | MovePlan,
      decisions: Record<string, ConflictPolicy>,
    ) => {
      closeDialog();
      const conflictNames = new Set(plan.conflicts.map((c) => c.name));
      const groups = new Map<ConflictPolicy, EntryRef[]>();
      const rest: EntryRef[] = [];
      for (const it of plan.items) {
        if (!conflictNames.has(it.name)) {
          rest.push(it);
          continue;
        }
        const p = decisions[it.name] ?? "skip";
        if (p === "skip") continue;
        groups.set(p, [...(groups.get(p) ?? []), it]);
      }
      if (rest.length > 0) {
        // 비충돌 항목은 정책과 무관 — 아무 그룹에나 합류. 전부 skip 이었으면
        // 비충돌만 담은 그룹(정책값 무의미)으로 실행.
        const first = groups.keys().next();
        if (!first.done) groups.get(first.value)!.push(...rest);
        else groups.set("skip", rest);
      }
      if (groups.size === 0) {
        showToast(i18n.t("toast.nothingToDo"));
        return;
      }
      let show: { taskId: string; count: number } | null = null;
      for (const [policy, items] of groups) {
        let taskId: string | null = null;
        if (mode === "copy") {
          const p = await commands.fsCopyPlan(items, plan.dst);
          if (p.status === "error") {
            showToast(
              i18n.t("toast.copyPlanFailed", { err: formatErr(p.error) }),
              "error",
            );
            continue;
          }
          const r = await commands.fsCopyExecute(p.data, policy);
          if (r.status === "error") {
            showToast(
              i18n.t("toast.copyFailed", { err: formatErr(r.error) }),
              "error",
            );
            continue;
          }
          rememberElevatable(r.data, { op: "copy", plan: p.data, policy });
          taskId = r.data;
        } else {
          const p = await commands.fsMovePlan(items, plan.dst);
          if (p.status === "error") {
            showToast(
              i18n.t("toast.movePlanFailed", { err: formatErr(p.error) }),
              "error",
            );
            continue;
          }
          const r = await commands.fsMoveExecute(p.data, policy);
          if (r.status === "error") {
            showToast(
              i18n.t("toast.moveFailed", { err: formatErr(r.error) }),
              "error",
            );
            continue;
          }
          rememberElevatable(r.data, { op: "move", plan: p.data, policy });
          taskId = r.data;
        }
        if (taskId && (!show || items.length > show.count))
          show = { taskId, count: items.length };
      }
      if (show) {
        openDialog({
          kind: "progress",
          title:
            mode === "copy"
              ? i18n.t("dialog.progress.copying")
              : i18n.t("dialog.progress.moving"),
          taskId: show.taskId,
        });
      }
    },
    [closeDialog, openDialog, showToast],
  );

  // 로컬 UAC 승격 실행 — op 로 커맨드 선택(결과 타입은 셋 다 ElevatedOutcome 동일).
  const runElevated = useCallback((p: ElevatablePlan) => {
    if (p.op === "copy")
      return commands.fsCopyExecuteElevated(p.plan, p.policy);
    if (p.op === "move")
      return commands.fsMoveExecuteElevated(p.plan, p.policy);
    return commands.fsDeleteExecuteElevated(p.plan, p.confirmWord);
  }, []);

  /** 보호 경로 copy/move/delete 권한 실패 → 로컬 UAC 승격 재시도. */
  const onElevateConfirm = useCallback(async () => {
    if (dialog.kind !== "elevate-op") return;
    const p = dialog.pending;
    closeDialog();
    const r = await runElevated(p);
    if (r.status === "error") {
      showToast(
        i18n.t("toast.elevatedFailed", { op: p.op, err: formatErr(r.error) }),
        "error",
      );
      return;
    }
    const o = r.data;
    if (o.cancelled) {
      showToast(i18n.t("toast.elevationCancelled"));
      return;
    }
    if (o.failed.length > 0) {
      showToast(
        i18n.t("toast.partialFailed", {
          ok: o.ok,
          failed: o.failed.length,
          first: o.failed[0],
        }),
        "error",
      );
    } else {
      showToast(i18n.t("toast.doneAsAdmin", { count: o.ok }), "success");
    }
    onRefresh("left");
    onRefresh("right");
  }, [dialog, closeDialog, showToast, onRefresh, runElevated]);

  // 원격 sudo 실행 — op 로 커맨드 선택(결과 타입 셋 다 SudoOutcome 동일).
  const runSudo = useCallback((p: ElevatablePlan, password: string | null) => {
    if (p.op === "copy")
      return commands.fsCopyExecuteSudo(p.plan, p.policy, password);
    if (p.op === "move")
      return commands.fsMoveExecuteSudo(p.plan, p.policy, password);
    return commands.fsDeleteExecuteSudo(p.plan, password, p.confirmWord);
  }, []);

  /** 원격 sudo 결과 처리 — 비번 필요/오류면 비번 다이얼로그, 성공이면 토스트+새로고침. */
  const handleSudoResult = useCallback(
    (
      r: Awaited<ReturnType<typeof commands.fsCopyExecuteSudo>>,
      p: ElevatablePlan,
    ) => {
      if (r.status === "error") {
        showToast(
          i18n.t("toast.sudoFailed", { op: p.op, err: formatErr(r.error) }),
          "error",
        );
        return;
      }
      const o = r.data;
      if (o.status === "needPassword") {
        openDialog({ kind: "sudo-password", pending: p });
        return;
      }
      if (o.status === "wrongPassword") {
        openDialog({ kind: "sudo-password", pending: p, error: true });
        return;
      }
      if (o.failed.length > 0) {
        showToast(
          i18n.t("toast.partialFailed", {
            ok: o.count,
            failed: o.failed.length,
            first: o.failed[0],
          }),
          "error",
        );
      } else {
        showToast(i18n.t("toast.doneWithSudo", { count: o.count }), "success");
      }
      onRefresh("left");
      onRefresh("right");
    },
    [openDialog, showToast, onRefresh],
  );

  /** sudo 재시도 (확인 → passwordless 먼저). */
  const onSudoRetry = useCallback(async () => {
    if (dialog.kind !== "sudo-op") return;
    const p = dialog.pending;
    closeDialog();
    const r = await runSudo(p, null);
    handleSudoResult(r, p);
  }, [dialog, closeDialog, handleSudoResult, runSudo]);

  /** sudo 비번 입력 후 재시도. */
  const onSudoPasswordConfirm = useCallback(
    async (password: string) => {
      if (dialog.kind !== "sudo-password") return;
      const p = dialog.pending;
      closeDialog();
      const r = await runSudo(p, password);
      handleSudoResult(r, p);
    },
    [dialog, closeDialog, handleSudoResult, runSudo],
  );

  const onSyncConfirm = useCallback(
    async (prune: boolean) => {
      if (dialog.kind !== "sync-confirm") return;
      const plan = { ...dialog.plan, prune };
      const r = await commands.fsSyncExecute(plan);
      if (r.status === "ok") {
        openDialog({
          kind: "progress",
          title: i18n.t("dialog.progress.syncing"),
          taskId: r.data,
        });
      } else {
        closeDialog();
        showToast(
          i18n.t("toast.syncFailed", { err: formatErr(r.error) }),
          "error",
        );
      }
    },
    [dialog, openDialog, closeDialog, showToast],
  );

  const onMoveConfirm = useCallback(
    async (policy: ConflictPolicy) => {
      if (dialog.kind !== "move-confirm") return;
      await executeTransfer(
        "move",
        dialog.plan,
        policy,
        openDialog,
        closeDialog,
        showToast,
      );
    },
    [dialog, openDialog, closeDialog, showToast],
  );

  // 새 연결 다이얼로그 — 호스트 더블클릭/즐겨찾기 자동접속 시 alias 가 들어옴.
  const [dialogAlias, setDialogAlias] = useState<string | null>(null);
  /**
   * 연결 대화상자 문맥 — 처음 선택할 패널(보통 활성 패널), 배너 재연결이면 고정
   * 패널과 대화상자 없이 시도했다 실패한 이유. 예전엔 대화상자가 늘 "왼쪽"으로
   * 열려 배너 재연결도 패널을 다시 물었다.
   */
  const [connectCtx, setConnectCtx] = useState<{
    pane: PaneId;
    reconnect: ReconnectInfo | null;
  }>({ pane: "left", reconnect: null });
  /**
   * **대화상자를 거치는** 연결의 갈 곳 — 대화상자가 onConnected 를 부를 때 꺼낸다.
   * 대화상자 없이 끝나는 배너 재연결은 이 ref 를 쓰지 않고 목표를 직접 넘긴다
   * (공유 ref 를 await 너머로 들고 있으면 그사이 다른 연결 흐름이 덮어썼다).
   * 대화상자를 닫으면 지운다(취소한 경로가 다음 연결에 끼어들지 않게).
   */
  const pendingNav = useRef<ConnectNav | null>(null);

  // ad-hoc connect 다이얼로그 (Sidebar + 버튼, saved host 더블클릭, alias 폴백)
  const [adHocOpen, setAdHocOpen] = useState(false);
  const [adHocPrefill, setAdHocPrefill] = useState<SavedHost | null>(null);

  /** 연결 대화상자 문맥 설정 — 패널 미지정이면 지금 활성 패널. */
  const setConnectTarget = useCallback(
    (ctx?: { pane?: PaneId; reconnect?: ReconnectInfo | null }) =>
      setConnectCtx({
        pane: ctx?.pane ?? usePanes.getState().activePane,
        reconnect: ctx?.reconnect ?? null,
      }),
    [],
  );

  const onAdHocOpen = useCallback(() => {
    setConnectTarget();
    setAdHocPrefill(null);
    setAdHocOpen(true);
  }, [setConnectTarget]);

  const onSavedActivate = useCallback(
    (host: SavedHost) => {
      // 이 저장 호스트의 연결 alias 가 배너 재연결 중이면 대화상자를 또 띄우지 않는다.
      const connAlias = `${host.user}@${host.host}:${host.port}`;
      if (connAlias in useConnections.getState().reconnecting) {
        showToast(i18n.t("toast.reconnectInProgress", { alias: host.alias }));
        return;
      }
      setConnectTarget();
      setAdHocPrefill(host);
      setAdHocOpen(true);
    },
    [setConnectTarget, showToast],
  );

  /**
   * alias 로 연결 흐름 열기 — 즐겨찾기/북마크/배너 Reconnect 공용.
   *
   * - `~/.ssh/config` 의 alias → ConnectionDialog
   * - 저장된 호스트 (alias 그대로 또는 `user@host:port` 가 일치) → 프리필 ad-hoc
   * - 저장은 안 됐지만 `user@host:port` 형식 → 그 값으로 프리필한 ad-hoc
   * - 그 외 → 빈 ad-hoc
   *
   * ConnectionDialog 는 ssh-config 호스트가 아니면 **열리지 않기** 때문에
   * (`ConnectionDialog` 의 `open = host !== undefined`), ad-hoc 으로 접속해
   * 만든 즐겨찾기는 이 라우팅이 없으면 더블클릭해도 무반응이었다.
   */
  const connectToAlias = useCallback(
    (
      alias: string,
      ctx?: { pane?: PaneId; reconnect?: ReconnectInfo | null },
    ) => {
      setConnectTarget(ctx);
      if (useConnections.getState().hosts.some((h) => h.alias === alias)) {
        setDialogAlias(alias);
        return;
      }
      const saved = findSavedHostForAlias(
        alias,
        useSavedHosts.getState().hosts,
      );
      setAdHocPrefill(saved ?? prefillFromAlias(alias));
      setAdHocOpen(true);
    },
    [setConnectTarget],
  );

  /**
   * 호스트 경로로 이동 — 연결돼 있으면 지정 pane 으로 바로, 아니면 연결 흐름 →
   * 성공 시 그 경로로 이동(onConnected 가 pendingNav 처리). 호스트-인식 북마크/즐겨찾기 핵심.
   *
   * 연결 조회는 반드시 `liveByAlias` — 재연결 포기로 백엔드 pool 에서 사라진
   * 연결도 배너용으로 store 엔 error 상태로 남아 있어서, alias 만 보고 고르면
   * 죽은 id 로 이동해 `no connection` 으로 실패한다.
   */
  const onOpenHostPath = useCallback(
    (hostAlias: string, path: string, pane: PaneId) => {
      const conn = useConnections.getState().liveByAlias(hostAlias);
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
      if (hostAlias in useConnections.getState().reconnecting) {
        // 배너 재연결이 진행 중 — 대화상자를 하나 더 띄우면 세션이 둘 생긴다.
        showToast(i18n.t("toast.reconnectInProgress", { alias: hostAlias }));
        return;
      }
      pendingNav.current = { alias: hostAlias, path, pane };
      connectToAlias(hostAlias, { pane });
    },
    [navigateTo, connectToAlias, showToast],
  );

  /** 활성 탭 위치를 북마크 — SSH 면 호스트 즐겨찾기로(재접속 안전), 로컬이면 북마크. */
  const onAddBookmark = useCallback(() => {
    const tab = activeTab(usePanes.getState(), usePanes.getState().activePane);
    void bookmarkLocation(tab.location, folderName(tab.location));
  }, []);

  /**
   * 사이드바/팔레트에서 config 호스트 열기. 이미 연결돼 있으면 대화상자를 다시
   * 띄워 세션을 하나 더 만들지 않고, 활성 패널을 그 호스트의 홈으로 옮긴다.
   */
  const onHostActivate = useCallback(
    (alias: string) => {
      const pane = usePanes.getState().activePane;
      const live = useConnections.getState().liveByAlias(alias);
      if (live) {
        void (async () => {
          const home = await commands.sshHomeDirectory(live.id);
          void navigateTo(pane, {
            source: {
              kind: "ssh",
              connection_id: live.id,
              host_ip: live.host_ip,
              user: live.user,
            },
            path: home.status === "ok" ? home.data : "/",
          });
        })();
        return;
      }
      if (alias in useConnections.getState().reconnecting) {
        showToast(i18n.t("toast.reconnectInProgress", { alias }));
        return;
      }
      pendingNav.current = null;
      setConnectTarget({ pane });
      setDialogAlias(alias);
    },
    [navigateTo, setConnectTarget, showToast],
  );

  /**
   * 사용자 별칭 실행. connect 별칭은 실제로 접속한다 — 예전엔 "먼저 연결하세요"/
   * "연결됨" 토스트만 띄우고 아무것도 하지 않았다. 이미 연결(또는 재연결 중)이면
   * 사이드바 호스트 더블클릭과 같은 경로, 아니면 저장 호스트 프리필 접속.
   */
  const onAliasExecute = useCallback(
    (alias: UserAlias) => {
      const pane = usePanes.getState().activePane;
      if (alias.kind.kind === "navigate") {
        void navigateTo(pane, alias.kind.location);
      } else if (alias.kind.kind === "connect") {
        const target = alias.kind.saved_host_alias;
        // 저장 호스트 이름(사용자가 붙인 별명)과 실제 연결 alias(user@host:port)는
        // 다를 수 있다 — 둘 다로 기존 연결·재연결을 찾는다.
        const saved = useSavedHosts
          .getState()
          .hosts.find((h) => h.alias === target);
        const candidates = saved
          ? [target, `${saved.user}@${saved.host}:${saved.port}`]
          : [target];
        const conns = useConnections.getState();
        const existing = candidates.find(
          (a) => conns.liveByAlias(a) || a in conns.reconnecting,
        );
        if (existing) {
          onHostActivate(existing);
          return;
        }
        pendingNav.current = null;
        if (saved) onSavedActivate(saved);
        else connectToAlias(target, { pane });
      }
    },
    [navigateTo, onHostActivate, onSavedActivate, connectToAlias],
  );

  // 팔레트/동적 커맨드용 — 활성 패널 기준 래퍼.
  const onBookmarkActivate = useCallback(
    (location: Location) =>
      onOpenLocation(location, usePanes.getState().activePane),
    [onOpenLocation],
  );
  openHostPathRef.current = onOpenHostPath;

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
    onHostActivate,
    onBookmarkActivate,
    onFavoriteActivate,
    onAliasExecute,
  });

  /**
   * 연결 성공 후 처리 — 대화상자·배너 재연결 공용.
   *
   * 1. 같은 호스트의 끊긴 탭(양쪽 패널·비활성 포함)을 모두 새 연결로 다시 묶는다.
   * 2. 배너 재연결이면 버튼이 있던 그 탭으로 돌아간다(그사이 탭을 옮겼어도).
   * 3. 가려던 경로 → 홈 → `~` → `/` 순으로 첫 성공한 위치를 연다. 홈 조회는
   *    가려던 경로가 실패했을 때만.
   */
  const onConnected = useCallback(
    async (paneId: PaneId, dto: ConnectionDto, nav?: ConnectNav) => {
      const ssh: SshSource = {
        kind: "ssh",
        connection_id: dto.id,
        // backend 가 getpeername() 으로 캡처한 실제 peer IP — IpAddr deserialize
        // 위해 반드시 valid IP 문자열이어야 함 (이전엔 빈 문자열 보내서 IPC reject).
        host_ip: dto.host_ip,
        user: dto.user,
      };
      const alias = dto.alias;
      // 대화상자 경로의 목표는 자기 alias 일 때만 꺼내 쓴다(다른 요청 것은 건드리지 않음).
      const fromDialog =
        pendingNav.current?.alias === alias ? pendingNav.current : null;
      if (fromDialog) pendingNav.current = null;
      const pending = nav ?? fromDialog;

      const rebound = rebindHostTabs(alias, ssh);
      pruneDeadConnections(alias);

      // 착지할 탭을 정하고 끝까지 그 탭에만 쓴다. 배너 재연결이면 버튼이 있던 탭
      // (반대 패널로 옮겼으면 따라감, 닫혔으면 새 탭), 아니면 대상 패널의 현재 탭.
      let pane = pending?.tabId ? pending.pane : paneId;
      let targetId: string;
      const st = usePanes.getState();
      if (pending?.tabId) {
        const found = findTab(pending.tabId);
        const loc = found
          ? st.panes[found.pane].tabs[found.index]!.location
          : null;
        // 연결을 기다리는 사이 그 탭을 다른 곳으로 옮겼으면(로컬 폴더 등) 덮지 않는다 —
        // 이미 rebind 는 끝났으니 반대 패널만 새로 읽고 여기서 멈춘다.
        const moved =
          loc !== null &&
          (loc.source.kind !== "ssh" ||
            aliasFromConnectionId(loc.source.connection_id) !== alias ||
            String(loc.path) !== pending.path);
        if (moved) {
          for (const other of rebound.panes) onRefresh(other);
          return;
        }
        if (found) {
          pane = found.pane;
          if (found.index !== st.panes[pane].activeTabIndex)
            st.selectTab(pane, found.index);
          targetId = pending.tabId;
        } else {
          st.openTab(pane, { source: ssh, path: pending.path });
          targetId = activeTab(usePanes.getState(), pane).id;
        }
      } else {
        targetId = activeTab(st, pane).id;
      }
      // 반대 패널의 보이는 탭도 같은 호스트였으면 새 연결로 다시 읽는다.
      for (const other of rebound.panes) if (other !== pane) onRefresh(other);

      /** 사용자가 그사이 탭을 바꾸거나 다른 곳으로 이동했나 — 그러면 손대지 않는다. */
      const stillTarget = () =>
        activeTab(usePanes.getState(), pane).id === targetId;
      const failures: string[] = [];
      /** 이 경로를 목표 탭에 연다. stale = 사용자가 그사이 움직였음 → 흐름 전체 중단. */
      const land = async (
        path: string,
      ): Promise<"applied" | "failed" | "stale"> => {
        if (!stillTarget()) return "stale";
        const loc: Location = { source: ssh, path };
        // 탭 단위 이동 토큰 (lib/tabNav) — 그 탭의 더 새 이동이 이기고, 새로고침은
        // 토큰을 올리지 않아 이 착지를 취소하지 않는다.
        const latest = beginTabNav(targetId);
        const current = () => latest() && stillTarget();
        try {
          const entries = await listEntries(loc);
          if (!current()) return "stale";
          usePanes
            .getState()
            .setEntries(pane, loc, entries, { tabId: targetId });
          void commands.paneWatchSet(pane, loc);
          return "applied";
        } catch (e) {
          if (!current()) return "stale";
          // useTauri throws DuetError 또는 IpcError; formatErr 가 양쪽 처리.
          failures.push(`${path}: ${formatErr(e)}`);
          return "failed";
        }
      };
      let result: "applied" | "failed" | "stale" = "failed";
      let landed: string | null = null;
      if (pending) {
        result = await land(pending.path);
        if (result === "applied") landed = pending.path;
      }
      if (result === "failed") {
        // 홈 조회를 기다리는 사이 같은 탭에서 다른 곳으로 이동했으면(탭 토큰 변경) 멈춘다 —
        // 이어서 land 가 새 토큰을 받아 그 최신 이동을 덮어쓰던 경로.
        const homeTok = peekTabNav(targetId);
        const homeRes = await commands.sshHomeDirectory(dto.id);
        if (!stillTarget() || !homeTok()) return;
        const tries = ["~", "/"];
        if (homeRes.status === "ok") tries.unshift(homeRes.data);
        else failures.push(`~: ${formatErr(homeRes.error)}`);
        for (const path of tries) {
          result = await land(path);
          if (result === "applied") landed = path;
          if (result !== "failed") break;
        }
      }
      if (result === "stale") return;
      if (landed === null) {
        showToast(
          i18n.t("toast.connectedListFailed", {
            alias,
            failures: failures.join("\n"),
          }),
          "error",
        );
        return;
      }
      usePanes.getState().setActivePane(pane);
      const paneLabel = i18n.t(
        pane === "left"
          ? "dialog.connection.paneLeft"
          : "dialog.connection.paneRight",
      );
      showToast(
        pending?.tabId && rebound.tabs > 1
          ? i18n.t("toast.reconnectedTabs", { alias, count: rebound.tabs })
          : i18n.t("toast.connected", { alias, pane: paneLabel, path: landed }),
        "success",
      );
    },
    [listEntries, showToast, onRefresh],
  );

  /**
   * SSH 배너 "재연결" — 버튼이 있던 그 패널·그 탭·그 경로로 돌아간다.
   *
   * 먼저 대화상자 없이 다시 붙어 본다(키/에이전트, 저장된 비밀번호는 백엔드가
   * vault 에서 직접). 비밀번호·호스트 키·잠긴 vault 처럼 사람이 답해야 할 때만
   * 패널이 고정된 대화상자를 연다. 진행 중엔 그 호스트의 배너가 모두 스피너를
   * 띄우고 버튼이 사라져 연타로 연결이 여러 개 생기지 않는다.
   */
  const onPaneReconnect = useCallback(
    async (alias: string | null, paneId: PaneId) => {
      const reconnect: ReconnectInfo = { pane: paneId, error: null };
      if (!alias) {
        connectToAlias("", { pane: paneId, reconnect });
        return;
      }
      const conns = useConnections.getState();
      if (alias in conns.reconnecting) return;
      const tab = activeTab(usePanes.getState(), paneId);
      // 이 요청만의 목표 — 공유 ref 에 두지 않고 직접 넘긴다(동시 재연결 격리).
      const nav: ConnectNav = {
        alias,
        path: String(tab.location.path),
        pane: paneId,
        tabId: tab.id,
      };
      // 다른 탭이 이미 다시 연결해 둔 경우 — 새 세션 없이 그 연결에 붙인다.
      const live = conns.liveByAlias(alias);
      if (live) {
        await onConnected(paneId, live, nav);
        return;
      }
      conns.setReconnecting(alias, true);
      try {
        let r: QuickReconnectResult;
        try {
          r = await quickReconnect(alias);
        } catch (e) {
          r = {
            kind: "failed",
            error: { kind: "ConnectionFailed", message: formatErr(e) },
          };
        }
        if (r.kind === "ok") {
          useConnections.getState().upsertActive({
            ...r.dto,
            state: { kind: "connected" },
          });
          await onConnected(paneId, r.dto, nav);
        } else if (r.kind === "dialog") {
          pendingNav.current = nav;
          connectToAlias(alias, {
            pane: paneId,
            reconnect: { pane: paneId, error: r.error },
          });
        } else {
          showToast(
            i18n.t("toast.reconnectFailed", { alias, err: formatErr(r.error) }),
            "error",
          );
        }
      } finally {
        useConnections.getState().setReconnecting(alias, false);
      }
    },
    [connectToAlias, onConnected, showToast],
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
          const tabs = usePanes.getState().panes[pane].tabs.map((t) => ({
            path: String(t.location.path),
            // 복원된 원격 탭은 아직 연결이 없다 — 목록을 읽으려 하면 실패 토스트만
            // 뜬다. 비워 둔 채로 두면 패널이 "연결 끊김 + 다시 연결" 배너를 띄운다.
            remote: isRestoredRemote(t.location),
          }));
          const savedActive = usePanes.getState().panes[pane].activeTabIndex;
          for (let i = 0; i < tabs.length; i++) {
            if (tabs[i]!.remote) continue;
            usePanes.getState().selectTab(pane, i);
            await navigate(pane, tabs[i]!.path, { pushHistory: false });
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
      void bootstrapHostNicknames();
      void bootstrapTags();
      // vault 상태(있음/잠김)를 여기서 한 번 읽어야 저장된 호스트 비밀번호가 재시작
      // 후에도 쓰인다 — 안 읽으면 store 가 exists=false 로 남아 "Unlock vault" 가
      // 아예 안 보이고, 백엔드는 비번 없이 키/agent 만 시도해 AuthFailed 로 끝났다.
      void useVault.getState().refresh();
      // 설정 적용 — 테마 + 새 탭 기본값(정렬/뷰/숨김). 세션 복원이 없었으면 기존 탭에도.
      void commands.settingsGet().then((r) => {
        if (r.status === "ok") {
          applyTheme(r.data.theme ?? "system");
          applyTabDefaults(
            {
              sortKey: (r.data.default_sort ?? "mtime") as SortKey,
              viewMode: (r.data.default_view ?? "details") as ViewMode,
              showHidden: r.data.show_hidden_default ?? false,
            },
            // 복원한 탭은 저장된 탭별 정렬·보기를 유지한다 — 새 탭 기본값만 갱신.
            { existing: !saved },
          );
          syncAppSettings(r.data);
          useAppSettings
            .getState()
            .setExtIconOverrides(
              (r.data.ext_icon_overrides ?? {}) as Record<string, string>,
            );
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

      <WorkspaceLayout
        sidebar={
          <Sidebar
            onHostActivate={onHostActivate}
            onAdHocOpen={onAdHocOpen}
            onSavedActivate={onSavedActivate}
            onOpenLocation={onOpenLocation}
            onOpenHostPath={onOpenHostPath}
            onAddBookmark={onAddBookmark}
            onTrashActivate={onTrashActivate}
            onEject={onEject}
          />
        }
      >
        {(!singlePane || visiblePane === "left") && (
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
            onReconnect={onPaneReconnect}
          />
        )}
        {!singlePane && <SwapPanesButton />}
        {(!singlePane || visiblePane === "right") && (
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
            onReconnect={onPaneReconnect}
          />
        )}
      </WorkspaceLayout>

      <TasksBar />
      <StatusBar />

      <ConnectionDialog
        alias={dialogAlias}
        onClose={() => {
          pendingNav.current = null;
          setDialogAlias(null);
        }}
        onConnected={onConnected}
        defaultPane={connectCtx.pane}
        reconnect={connectCtx.reconnect}
      />
      <AdHocConnectDialog
        open={adHocOpen}
        onClose={() => {
          pendingNav.current = null;
          setAdHocOpen(false);
        }}
        onConnected={onConnected}
        prefill={adHocPrefill}
        defaultPane={connectCtx.pane}
        reconnect={connectCtx.reconnect}
      />

      {dialog.kind === "batch-rename" && (
        <BatchRenameDialog
          targets={dialog.targets}
          onClose={closeDialog}
          onSubmit={onBatchRenameSubmit}
        />
      )}
      {dialog.kind === "mkdir" && (
        <NewEntryDialog
          kind="dir"
          parent={dialog.parent}
          onClose={closeDialog}
          onSubmit={onCreateEntrySubmit}
        />
      )}
      {dialog.kind === "new-file" && (
        <NewEntryDialog
          kind="file"
          parent={dialog.parent}
          onClose={closeDialog}
          onSubmit={onCreateEntrySubmit}
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
      {dialog.kind === "checksum" && (
        <ChecksumDialog targets={dialog.targets} onClose={closeDialog} />
      )}
      {dialog.kind === "permissions" && (
        <PermissionsDialog
          targets={dialog.targets}
          initialMode={dialog.initialMode}
          remote={dialog.remote}
          hasDir={dialog.hasDir}
          onClose={closeDialog}
          onApplied={() =>
            // perms 는 목록/인스펙터의 permissions 값 갱신용 refresh.
            refreshAffected([dialog.targets[0]!.location])
          }
        />
      )}
      {dialog.kind === "symlink" && (
        <SymlinkDialog
          parent={dialog.parent}
          onClose={closeDialog}
          onSubmit={(name, target) => {
            void (async () => {
              const r = await commands.fsMakeSymlink(
                dialog.parent,
                name,
                target,
              );
              if (r.status === "error") {
                showToast(
                  i18n.t("toast.symlinkFailed", { err: formatErr(r.error) }),
                  "error",
                );
                return;
              }
              closeDialog();
              refreshAffected([dialog.parent]);
            })();
          }}
        />
      )}
      {dialog.kind === "extract-password" && (
        <PasswordPromptDialog
          archiveName={dialog.plan.archive_name}
          wrongPassword={dialog.wrong}
          onClose={closeDialog}
          submit={async (pw) => {
            // 커맨드는 task enqueue 후 TaskId 를 즉시 반환 — 암호가 틀리면 task 가
            // NeedPassword 로 실패하고 useTaskEvents 가 이 다이얼로그를 다시 연다.
            const r = await commands.fsExtractExecute(dialog.plan, pw);
            if (r.status === "error") {
              showToast(
                i18n.t("toast.extractFailed", { err: formatErr(r.error) }),
                "error",
              );
              return "ok";
            }
            rememberExtract(r.data, { plan: dialog.plan, attempted: true });
            return "ok";
          }}
        />
      )}
      {dialog.kind === "browse-password" && (
        <PasswordPromptDialog
          archiveName={dialog.archive.name}
          onClose={closeDialog}
          submit={async (pw) => {
            // 처음 열기를 시작한 탭 — 암호를 묻는 사이 탭을 바꿨어도 그 탭에 연다.
            const tabId =
              dialog.tabId ?? activeTab(usePanes.getState(), dialog.paneId).id;
            const current = beginTabNav(tabId);
            const r = await commands.fsArchiveOpenForBrowse(dialog.archive, pw);
            if (r.status === "ok") {
              if (await navigateTo(dialog.paneId, r.data, { tabId, current }))
                usePanes.getState().setArchiveContext(
                  dialog.paneId,
                  {
                    label: dialog.archive.name,
                    root: r.data.path,
                    exitTo: dialog.archive.location,
                  },
                  tabId,
                );
              return "ok";
            }
            if (r.error.kind === "NeedPassword") return "retry";
            showToast(
              i18n.t("toast.cannotOpen", {
                name: dialog.archive.name,
                err: formatErr(r.error),
              }),
              "error",
            );
            return "ok";
          }}
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
        <DeleteTrashDialog
          plan={dialog.plan}
          onCancel={closeDialog}
          // 인자 없이 호출 — 버튼 onClick 이 이벤트를 넘기지 않도록 래핑.
          onConfirm={() => onDeleteConfirm()}
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
                  title: i18n.t("dialog.progress.applying3way"),
                  taskId: r.data,
                });
              } else {
                closeDialog();
                showToast(
                  i18n.t("toast.threeWayApplyFailed", {
                    err: formatErr(r.error),
                  }),
                  "error",
                );
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
                  title: i18n.t("dialog.progress.merging"),
                  taskId: r.data,
                });
              } else {
                closeDialog();
                showToast(
                  i18n.t("toast.mergeFailed", { err: formatErr(r.error) }),
                  "error",
                );
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
                  title: i18n.t("dialog.progress.applying"),
                  taskId: r.data,
                });
              } else {
                closeDialog();
                showToast(
                  i18n.t("toast.applyFailed", { err: formatErr(r.error) }),
                  "error",
                );
              }
            })();
          }}
        />
      )}
      {dialog.kind === "sync-confirm" && (
        <SyncDialog
          src={dialog.plan.src}
          dst={dialog.plan.dst}
          onClose={closeDialog}
          onConfirm={(prune) => void onSyncConfirm(prune)}
        />
      )}
      {dialog.kind === "repack-confirm" && (
        <ConfirmDialog
          title={i18n.t("dialog.repack.title", { label: dialog.label })}
          body={i18n.t("dialog.repack.body", {
            count: dialog.plan.item_names.length,
          })}
          ctaLabel={i18n.t("dialog.repack.cta")}
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onRepackConfirm}
        />
      )}
      {dialog.kind === "eject-confirm" && (
        <ConfirmDialog
          title={i18n.t("dialog.eject.title", { name: dialog.volume.name })}
          body={i18n.t("dialog.eject.body")}
          ctaLabel={i18n.t("dialog.eject.cta")}
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onEjectConfirm}
        />
      )}
      {dialog.kind === "delete-danger" && (
        <DeletePermanentDialog
          plan={dialog.plan}
          onCancel={closeDialog}
          onConfirm={onDeleteConfirm}
        />
      )}
      {dialog.kind === "trash-purge" && (
        <TrashPurgeDialog
          names={dialog.names}
          all={dialog.all}
          onCancel={closeDialog}
          onConfirm={(word) => void onTrashPurgeConfirm(word)}
        />
      )}
      {dialog.kind === "copy-confirm" && (
        <CopyMoveConfirmDialog
          kind="copy"
          plan={dialog.plan}
          onCancel={closeDialog}
          onConfirm={onCopyConfirm}
          onConfirmPerFile={(d) =>
            void onTransferPerFile("copy", dialog.plan, d)
          }
        />
      )}
      {dialog.kind === "elevate-op" && (
        <ConfirmDialog
          title={i18n.t("dialog.elevate.title")}
          body={
            <div>
              <Trans
                i18nKey={
                  dialog.pending.op === "delete"
                    ? "dialog.elevate.bodyDelete"
                    : "dialog.elevate.bodyWrite"
                }
                values={{ path: elevatableDestPath(dialog.pending) }}
                components={{ 1: <span className="break-all font-mono" /> }}
              />
            </div>
          }
          ctaLabel={i18n.t("dialog.elevate.cta")}
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={() => void onElevateConfirm()}
        />
      )}
      {dialog.kind === "sudo-op" && (
        <ConfirmDialog
          title={i18n.t("dialog.sudo.title")}
          body={
            <div>
              <Trans
                i18nKey={
                  dialog.pending.op === "delete"
                    ? "dialog.sudo.bodyDelete"
                    : "dialog.sudo.bodyWrite"
                }
                values={{ path: elevatableDestPath(dialog.pending) }}
                components={{
                  1: <span className="break-all font-mono" />,
                  3: <span className="font-mono" />,
                }}
              />
            </div>
          }
          ctaLabel={i18n.t("dialog.sudo.cta")}
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={() => void onSudoRetry()}
        />
      )}
      {dialog.kind === "sudo-password" && (
        <SudoPasswordDialog
          dest={elevatableDestPath(dialog.pending)}
          error={dialog.error ?? false}
          onCancel={closeDialog}
          onConfirm={(pw) => void onSudoPasswordConfirm(pw)}
        />
      )}
      {dialog.kind === "move-confirm" && (
        <CopyMoveConfirmDialog
          kind="move"
          plan={dialog.plan}
          onCancel={closeDialog}
          onConfirm={onMoveConfirm}
          onConfirmPerFile={(d) =>
            void onTransferPerFile("move", dialog.plan, d)
          }
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
      {dialog.kind === "shortcuts" && (
        <ShortcutCheatsheet onClose={closeDialog} />
      )}
      {dialog.kind === "history" && <HistoryDialog onClose={closeDialog} />}
      {quickLookOpen && <QuickLook />}
      <PromptDialogHost />
      <Toast />
      <CommandPalette />
      <FrecencyJumper
        onOpenLocation={onOpenLocation}
        onOpenHostPath={onOpenHostPath}
      />
      <ContextMenu />
      <DragGhost />
    </div>
  );
}

export default App;
