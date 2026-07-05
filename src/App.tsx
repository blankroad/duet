import { useEffect, useCallback, useState, useRef } from "react";
import { Pane } from "@/components/pane/Pane";
import { SwapPanesButton } from "@/components/pane/SwapPanesButton";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TasksBar } from "@/components/TasksBar";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { AdHocConnectDialog } from "@/components/connection/AdHocConnectDialog";
import { BatchRenameDialog } from "@/components/dialogs/BatchRenameDialog";
import { CompareDialog } from "@/components/dialogs/CompareDialog";
import { CompareScanningDialog } from "@/components/dialogs/CompareScanningDialog";
import { ThreeWayDialog } from "@/components/dialogs/ThreeWayDialog";
import { SyncDialog } from "@/components/dialogs/SyncDialog";
import { MkdirDialog } from "@/components/dialogs/MkdirDialog";
import { CompressDialog } from "@/components/dialogs/CompressDialog";
import { ChecksumDialog } from "@/components/dialogs/ChecksumDialog";
import { PermissionsDialog } from "@/components/dialogs/PermissionsDialog";
import { SymlinkDialog } from "@/components/dialogs/SymlinkDialog";
import { PasswordPromptDialog } from "@/components/dialogs/PasswordPromptDialog";
import { ArgsDialog } from "@/components/dialogs/ArgsDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { CopyMoveConfirmDialog } from "@/components/dialogs/CopyMoveConfirmDialog";
import { DangerConfirmDialog } from "@/components/dialogs/DangerConfirmDialog";
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
import { PreviewPane } from "@/components/pane/PreviewPane";
import { QuickLook } from "@/components/pane/QuickLook";
import { TopBar } from "@/components/TopBar";
import { DragGhost } from "@/components/pane/DragGhost";
import { CommandPalette } from "@/components/CommandPalette";
import { FrecencyJumper } from "@/components/FrecencyJumper";
import { useFrecency } from "@/stores/frecency";
import { ContextMenu } from "@/components/ContextMenu";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { openShellMenu, onShellMenuClose } from "@/lib/shellMenu";
import { buildEntryMenu, buildEmptyMenu, folderName } from "@/lib/entryMenu";
import { calcDirSizes } from "@/lib/dirSize";
import { toggleDropTray } from "@/lib/dropTray";
import {
  childLocation,
  parentPath,
  parentLocation,
  sameLocationDir,
} from "@/lib/entryDnd";
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
  triggerRedo,
  copySelectionPaths,
  copySelectionNames,
  clipCopy,
  clipCut,
  clipPaste,
  addSelectionToShelf,
  applyShelfTo,
} from "@/lib/fileActions";
import { useCommands } from "@/stores/commands";
import { usePalette } from "@/stores/palette";
import { buildBuiltins } from "@/lib/commands";
import { useUI } from "@/stores/ui";
import { useShelf } from "@/stores/shelf";
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
import { useKeymapEvents } from "@/hooks/useKeymapEvents";
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { useIndexProgressEvents } from "@/hooks/useIndexProgressEvents";
import i18n from "@/i18n";
import { useTranslation, Trans } from "react-i18next";
import { formatErr } from "@/lib/error";
import { formatSize } from "@/lib/format";
import { platform } from "@tauri-apps/plugin-os";
import { confirm as tauriConfirm } from "@tauri-apps/plugin-dialog";
import { commands } from "@/types/bindings";
import type {
  CompressFormat,
  ConnectionDto,
  CopyPlan,
  CopyStrategy,
  MovePlan,
  Entry,
  EntryRef,
  HostFavorite,
  ConflictPolicy,
  Location,
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
function App() {
  const { call: listDirectory } = useTauri("listDirectory");
  const showToast = useToast((s) => s.show);

  const navigate = useCallback(
    async (id: PaneId, path: string, opts: { pushHistory?: boolean } = {}) => {
      const state = usePanes.getState();
      const location = { ...activeTab(state, id).location, path };
      // 로드 중 표시 — 느린 SSH ls 에서 이전 목록이 그대로 보여 "무반응"으로
      // 오인되는 것 방지. setEntries 가 성공 시 자동 해제.
      state.setLoading(id, true);
      try {
        const entries = await listDirectory(location);
        state.setEntries(id, location, entries, {
          pushHistory: opts.pushHistory ?? true,
        });
        // navigate 성공 후 watcher 갱신. 실패는 silent — fs:changed 알림 안 옴
        // 정도의 영향. (사용자가 명시 새로고침으로 우회 가능.)
        void commands.paneWatchSet(id, location);
        if (opts.pushHistory !== false) {
          recordRecent(location);
          void commands.frecencyRecord(location); // 점퍼(Ctrl+J) 랭킹용
        }
      } catch (e) {
        usePanes.getState().setLoading(id, false);
        // 사용자가 더블클릭해도 silent fail 면 무반응으로 인식. toast 로 노출.
        showToast(
          i18n.t("toast.cannotOpen", { name: path, err: formatErr(e) }),
          "error",
        );
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
      usePanes.getState().setLoading(id, true);
      try {
        const entries = await listDirectory(location);
        usePanes.getState().setEntries(id, location, entries, {
          pushHistory: opts.pushHistory ?? true,
        });
        void commands.paneWatchSet(id, location);
        if (opts.pushHistory !== false) {
          recordRecent(location);
          void commands.frecencyRecord(location); // 점퍼(Ctrl+J) 랭킹용
        }
      } catch (e) {
        usePanes.getState().setLoading(id, false);
        showToast(
          i18n.t("toast.cannotOpen", {
            name: location.path,
            err: formatErr(e),
          }),
          "error",
        );
      }
    },
    [listDirectory, showToast],
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
      void (async () => {
        try {
          const entries = await listDirectory(target);
          usePanes
            .getState()
            .setEntries(opposite, target, entries, { pushHistory: true });
          void commands.paneWatchSet(opposite, target);
        } catch {
          /* 반대편에 대응 경로 없음 — 동행 skip */
        }
      })();
    },
    [listDirectory],
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
            showToast(
              i18n.t("toast.recycleBinError", { err: formatErr(r.error) }),
              "error",
            );
          return;
        }
        const r = await commands.trashLocation(src);
        if (r.status === "error") {
          showToast(
            i18n.t("toast.trashUnavailable", { err: formatErr(r.error) }),
            "error",
          );
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
      void navigate(id, parent);
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
      if (isArchiveName(entry.name)) {
        const archive = { location: tab.location, name: entry.name };
        void (async () => {
          // 1차는 암호 없이 — 암호 zip 이면 NeedPassword → 암호 입력 다이얼로그.
          const r = await commands.fsArchiveOpenForBrowse(archive, null);
          if (r.status === "error") {
            if (r.error.kind === "NeedPassword") {
              useUIDialogs
                .getState()
                .open({ kind: "browse-password", paneId: id, archive });
              return;
            }
            showToast(
              i18n.t("toast.cannotOpen", {
                name: entry.name,
                err: formatErr(r.error),
              }),
              "error",
            );
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
      // 새로고침은 같은 위치 재로드 — 히스토리(뒤로가기) 에 중복 push 하지 않음.
      navigate(id, tab.location.path, { pushHistory: false });
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
          { id: "up", label: "Open parent folder", onSelect: () => onUp(id) },
        ];
        if (par) {
          parentItems.push({
            id: "copy-parent-path",
            label: "Copy parent path",
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
        onActivate,
        onOpenInOtherPane,
        onPutBack,
      });
      // Windows 로컬 단일 선택: 실제 셸 메뉴(Tier 2)를 "More options ▸" 지연 항목으로.
      // 펼칠 때만 COM 조회 → 매번 읽지 않고, 메뉴가 갑자기 커지지도 않음(Win11 방식).
      let onClose: (() => void) | undefined;
      if (
        platform() === "windows" &&
        tab.location.source.kind === "local" &&
        selectedCount === 1
      ) {
        const child = childLocation(tab.location, entry.name);
        const scope: ShellScope = entry.kind === "dir" ? "directory" : "file";
        // 우클릭 즉시 백그라운드로 셸 메뉴 빌드 시작(prefetch) — "More options" 펼칠 때
        // COM 열거를 새로 안 기다려 지연 최소화. 미선택 시 onClose 가 세션 정리.
        const shellPromise = openShellMenu(String(child.path), scope);
        items.push(
          { kind: "separator" },
          {
            id: "win-more",
            label: "More options",
            loadChildren: async () => {
              const shell = await shellPromise;
              return shell ? shell.entries : [];
            },
          },
        );
        onClose = () => {
          void shellPromise.then((shell) => {
            if (shell) onShellMenuClose(shell.token);
          });
        };
      }
      useContextMenu.getState().openAt(cx, cy, items, onClose);
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
      });
      // Windows 로컬: 배경(빈 영역) 셸 메뉴를 "More options ▸" 지연 항목으로(펼칠 때만 조회).
      let onClose: (() => void) | undefined;
      if (platform() === "windows" && tab.location.source.kind === "local") {
        const bgPath = String(tab.location.path);
        // 우클릭 즉시 백그라운드로 빌드(prefetch). 미선택 시 onClose 가 세션 정리.
        const shellPromise = openShellMenu(bgPath, "background");
        items.push(
          { kind: "separator" },
          {
            id: "win-more",
            label: "More options",
            loadChildren: async () => {
              const shell = await shellPromise;
              return shell ? shell.entries : [];
            },
          },
        );
        onClose = () => {
          void shellPromise.then((shell) => {
            if (shell) onShellMenuClose(shell.token);
          });
        };
      }
      useContextMenu.getState().openAt(cx, cy, items, onClose);
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
  useKeymapEvents();
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
    (locations: Location[]) => {
      const state = usePanes.getState();
      for (const id of ["left", "right"] as const) {
        const loc = activeTab(state, id).location;
        if (locations.some((l) => sameLocationDir(l, loc))) onRefresh(id);
      }
    },
    [onRefresh],
  );

  useTaskEvents();

  const setBuiltins = useCommands((s) => s.setBuiltins);
  const openPalette = usePalette((s) => s.open);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const togglePreview = useUI((s) => s.togglePreview);
  const previewOpen = useUI((s) => s.previewOpen);
  const quickLookOpen = useUI((s) => s.quickLookOpen);
  // 단일 패널 모드 — 활성 패널만 렌더. 숨긴 쪽 상태는 panes store 에 보존되고
  // Tab(활성 패널 전환)이 곧 "보이는 패널 교체"가 된다.
  const singlePane = useUI((s) => s.singlePane);
  const visiblePane = usePanes((s) => s.activePane);

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
      jump: () => useFrecency.getState().open(),
      editPath: () =>
        useUI.getState().requestEditPath(usePanes.getState().activePane),
      refresh: () => onRefresh(usePanes.getState().activePane),
      toggleHidden: () =>
        usePanes.getState().toggleShowHidden(usePanes.getState().activePane),
      toggleSidebar: () => toggleSidebar(),
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

  const onMkdirSubmit = useCallback(
    async (name: string) => {
      if (dialog.kind !== "mkdir") return;
      const parent = dialog.parent;
      closeDialog();
      const r = await commands.fsMkdir(parent, name);
      if (r.status === "ok") refreshAffected([parent]);
      else
        showToast(
          i18n.t("toast.mkdirFailed", { err: formatErr(r.error) }),
          "error",
        );
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
      const plan = dialog.plan;
      const r = await commands.fsCopyExecute(plan, policy);
      if (r.status === "ok") {
        // 실패 시(보호 경로 권한 등) 승격 재시도를 위해 plan 을 기억.
        rememberElevatable(r.data, { op: "copy", plan, policy });
        openDialog({
          kind: "progress",
          title: i18n.t("dialog.progress.copying"),
          taskId: r.data,
        });
      } else {
        closeDialog();
        showToast(
          i18n.t("toast.copyFailed", { err: formatErr(r.error) }),
          "error",
        );
      }
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
      const plan = dialog.plan;
      const r = await commands.fsMoveExecute(plan, policy);
      if (r.status === "ok") {
        rememberElevatable(r.data, { op: "move", plan, policy });
        openDialog({
          kind: "progress",
          title: i18n.t("dialog.progress.moving"),
          taskId: r.data,
        });
      } else {
        closeDialog();
        showToast(
          i18n.t("toast.moveFailed", { err: formatErr(r.error) }),
          "error",
        );
      }
    },
    [dialog, openDialog, closeDialog, showToast],
  );

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
          showToast(i18n.t("toast.connectFirst", { alias: targetAlias }));
          return;
        }
        showToast(i18n.t("toast.hostConnected", { alias: targetAlias }));
      }
    },
    [navigateTo, showToast],
  );

  /** 활성 탭 위치를 북마크 — SSH 면 호스트 즐겨찾기로(재접속 안전), 로컬이면 북마크. */
  const onAddBookmark = useCallback(() => {
    const tab = activeTab(usePanes.getState(), usePanes.getState().activePane);
    void bookmarkLocation(tab.location, folderName(tab.location));
  }, []);

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

  /**
   * SSH 배너 Reconnect — ssh-config 호스트면 ConnectionDialog(연결 후 같은
   * 경로로 복귀, onOpenHostPath 의 pendingNav), 저장된 호스트면 프리필 ad-hoc,
   * 둘 다 모르면 빈 ad-hoc 다이얼로그.
   */
  const onPaneReconnect = useCallback(
    (alias: string | null, paneId: PaneId) => {
      const path = String(activeTab(usePanes.getState(), paneId).location.path);
      if (alias) {
        if (useConnections.getState().hosts.some((h) => h.alias === alias)) {
          onOpenHostPath(alias, path, paneId);
          return;
        }
        const saved = useSavedHosts
          .getState()
          .hosts.find((h) => h.alias === alias);
        if (saved) {
          onSavedActivate(saved);
          return;
        }
      }
      onAdHocOpen();
    },
    [onOpenHostPath, onSavedActivate, onAdHocOpen],
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
      else
        showToast(
          i18n.t("toast.sshHomeFailed", { err: formatErr(homeRes.error) }),
          "error",
        );
      candidates.push("~", "/");

      let succeeded = false;
      const failures: string[] = [];
      for (const path of candidates) {
        const loc = { source: ssh, path };
        try {
          const entries = await listDirectory(loc);
          state.setEntries(paneId, loc, entries);
          state.setActivePane(paneId);
          showToast(
            i18n.t("toast.connected", { alias, pane: paneId, path }),
            "success",
          );
          succeeded = true;
          break;
        } catch (e) {
          // useTauri throws DuetError 또는 IpcError; formatErr 가 양쪽 처리.
          failures.push(`${path}: ${formatErr(e)}`);
        }
      }
      if (!succeeded) {
        showToast(
          i18n.t("toast.connectedListFailed", {
            alias,
            failures: failures.join("\n"),
          }),
          "error",
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
      void bootstrapHostNicknames();
      void bootstrapTags();
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
          useAppSettings
            .getState()
            .setShowThumbnails(r.data.show_thumbnails ?? true);
          useAppSettings
            .getState()
            .setOsFileIcons(r.data.os_file_icons ?? platform() === "windows");
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

      <main className="flex flex-1 min-h-0 gap-1.5 p-1.5">
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
            const r = await commands.fsArchiveOpenForBrowse(dialog.archive, pw);
            if (r.status === "ok") {
              await navigateTo(dialog.paneId, r.data);
              usePanes.getState().setArchiveContext(dialog.paneId, {
                label: dialog.archive.name,
                root: r.data.path,
                exitTo: dialog.archive.location,
              });
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
        <ConfirmDialog
          title={i18n.t("dialog.deleteConfirm.title")}
          body={i18n.t("dialog.deleteConfirm.body", {
            count: dialog.plan.total_count,
            size: formatSize(dialog.plan.total_size_bytes),
          })}
          ctaLabel={i18n.t("common.delete")}
          ctaTone="neutral"
          onCancel={closeDialog}
          // 인자 없이 호출 — ConfirmDialog 의 onClick 이 이벤트를 넘기지 않도록 래핑.
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
        <DangerConfirmDialog
          title={i18n.t("dialog.deleteDanger.title")}
          body={i18n.t("dialog.deleteDanger.body", {
            count: dialog.plan.total_count,
          })}
          requiredWord="delete"
          onCancel={closeDialog}
          onConfirm={onDeleteConfirm}
        />
      )}
      {dialog.kind === "copy-confirm" && (
        <CopyMoveConfirmDialog
          title={i18n.t("dialog.transfer.copy")}
          body={
            <CopyOrMovePlanBody
              count={dialog.plan.items.length}
              totalSize={dialog.plan.total_size_bytes}
              dstPath={dialog.plan.dst.path}
              conflicts={dialog.plan.conflicts.length}
              strategy={dialog.plan.strategy}
            />
          }
          ctaLabel={i18n.t("dialog.transfer.copy")}
          conflicts={dialog.plan.conflicts}
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
          title={i18n.t("dialog.transfer.move")}
          body={
            <CopyOrMovePlanBody
              count={dialog.plan.items.length}
              totalSize={dialog.plan.total_size_bytes}
              dstPath={dialog.plan.dst.path}
              conflicts={dialog.plan.conflicts.length}
              strategy={dialog.plan.strategy}
            />
          }
          ctaLabel={i18n.t("dialog.transfer.move")}
          conflicts={dialog.plan.conflicts}
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
      <FrecencyJumper onOpenLocation={onOpenLocation} />
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
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div>
        {t("dialog.transfer.summary", { count, size: formatSize(totalSize) })}
      </div>
      {/* 긴 목적지 경로가 모달 밖으로 넘치지 않게 — 한 줄 truncate + 전체경로 tooltip. */}
      <div className="truncate font-mono" title={dstPath}>
        {dstPath}
      </div>
      <div className="text-meta text-fg-muted">
        {t("dialog.transfer.strategy", { label: strategyLabel(strategy) })}
      </div>
      {conflicts > 0 && (
        <div className="text-meta text-danger">
          {t("dialog.transfer.conflicts", { count: conflicts })}
        </div>
      )}
    </div>
  );
}

function strategyLabel(s: CopyStrategy): string {
  switch (s.kind) {
    case "local_to_local":
      return i18n.t("dialog.transfer.strategyLocal");
    case "relay":
      return i18n.t("dialog.transfer.strategyRelay");
    case "ssh_same_host":
      return i18n.t("dialog.transfer.strategySameHost");
  }
}

export default App;
