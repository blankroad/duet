import { useEffect, useCallback, useState } from "react";
import { Pane } from "@/components/pane/Pane";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { ConnectionDialog } from "@/components/connection/ConnectionDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { MkdirDialog } from "@/components/dialogs/MkdirDialog";
import { ConfirmDialog } from "@/components/dialogs/ConfirmDialog";
import { DangerConfirmDialog } from "@/components/dialogs/DangerConfirmDialog";
import { ProgressModal } from "@/components/dialogs/ProgressModal";
import { SettingsDialog } from "@/components/SettingsDialog";
import { Toast } from "@/components/Toast";
import { usePanes, type PaneId } from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { useTauri } from "@/hooks/useTauri";
import { useKeyboardNav } from "@/hooks/useKeyboardNav";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useSshHosts } from "@/hooks/useSshHosts";
import { useConnectionEvents } from "@/hooks/useConnectionEvents";
import { useFsChangedEvents } from "@/hooks/useFsChangedEvents";
import { useDestructiveKeys } from "@/hooks/useDestructiveKeys";
import { useJournalEvents } from "@/hooks/useJournalEvents";
import { formatErr } from "@/lib/error";
import { formatSize } from "@/lib/format";
import { commands } from "@/types/bindings";
import type { ConnectionId, Entry, Location } from "@/types/bindings";

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

  /** 디렉토리 정렬: dir 먼저, 같은 종류면 이름 오름차순 */
  const sortEntries = useCallback((entries: Entry[]): Entry[] => {
    return [...entries].sort((a, b) => {
      if (a.kind !== b.kind) {
        if (a.kind === "dir") return -1;
        if (b.kind === "dir") return 1;
      }
      return a.name.localeCompare(b.name);
    });
  }, []);

  const navigate = useCallback(
    async (id: PaneId, path: string) => {
      const state = usePanes.getState();
      const location = { ...state.panes[id].location, path };
      try {
        const entries = await listDirectory(location);
        state.setEntries(id, location, sortEntries(entries));
        // navigate 성공 후 watcher 갱신. 실패는 silent — fs:changed 알림 안 옴
        // 정도의 영향. (사용자가 명시 새로고침으로 우회 가능.)
        void commands.paneWatchSet(id, location);
      } catch {
        // useTauri가 error state에 저장 — UI는 다음 렌더에서 반영
      }
    },
    [listDirectory, sortEntries],
  );

  const onActivate = useCallback(
    (id: PaneId, entry: Entry) => {
      if (entry.kind !== "dir") return; // file open은 MVP-7
      const pane = usePanes.getState().panes[id];
      const sep = pane.location.path.endsWith("/") ? "" : "/";
      navigate(id, pane.location.path + sep + entry.name);
    },
    [navigate],
  );

  const onRefresh = useCallback(
    (id: PaneId) => {
      const pane = usePanes.getState().panes[id];
      navigate(id, pane.location.path);
    },
    [navigate],
  );

  const onKeyboardActivate = useCallback(
    (id: PaneId) => {
      const pane = usePanes.getState().panes[id];
      const entry = pane.entries[pane.cursorIndex];
      if (entry) onActivate(id, entry);
    },
    [onActivate],
  );

  const onKeyboardUp = useCallback(
    (id: PaneId) => {
      const path = usePanes.getState().panes[id].location.path;
      if (path === "/" || path.length === 0) return;
      const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
      navigate(id, parent);
    },
    [navigate],
  );

  useKeyboardNav(onKeyboardActivate, onKeyboardUp);
  useGlobalShortcuts();
  useSshHosts();
  useConnectionEvents();
  useFsChangedEvents(onRefresh);
  useDestructiveKeys();
  useJournalEvents();

  const dialog = useUIDialogs((s) => s.dialog);
  const closeDialog = useUIDialogs((s) => s.close);
  const openDialog = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  /** 영향받은 location 들이 현재 패널과 매칭되면 refresh. */
  const refreshAffected = useCallback(
    (locations: Location[]) => {
      const panes = usePanes.getState().panes;
      for (const id of ["left", "right"] as const) {
        const matches = locations.some(
          (loc) =>
            loc.source.kind === panes[id].location.source.kind &&
            (loc.source.kind === "local" ||
              ("connection_id" in loc.source &&
                "connection_id" in panes[id].location.source &&
                loc.source.connection_id ===
                  panes[id].location.source.connection_id)) &&
            loc.path === panes[id].location.path,
        );
        if (matches) onRefresh(id);
      }
    },
    [onRefresh],
  );

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

  const onDeleteConfirm = useCallback(async () => {
    if (dialog.kind !== "delete-confirm" && dialog.kind !== "delete-danger") return;
    const plan = dialog.plan;
    openDialog({ kind: "progress", title: "Deleting…" });
    const r = await commands.fsDeleteExecute(plan);
    closeDialog();
    if (r.status === "ok") refreshAffected([plan.source_location]);
    else showToast(`Delete failed: ${formatErr(r.error)}`);
  }, [dialog, openDialog, closeDialog, refreshAffected, showToast]);

  const onCopyConfirm = useCallback(async () => {
    if (dialog.kind !== "copy-confirm") return;
    const plan = dialog.plan;
    openDialog({ kind: "progress", title: "Copying…" });
    const r = await commands.fsCopyExecute(plan);
    closeDialog();
    if (r.status === "ok") refreshAffected([plan.dst]);
    else showToast(`Copy failed: ${formatErr(r.error)}`);
  }, [dialog, openDialog, closeDialog, refreshAffected, showToast]);

  const onMoveConfirm = useCallback(async () => {
    if (dialog.kind !== "move-confirm") return;
    const plan = dialog.plan;
    openDialog({ kind: "progress", title: "Moving…" });
    const r = await commands.fsMoveExecute(plan);
    closeDialog();
    if (r.status === "ok") {
      const srcLoc = plan.items[0]?.location;
      refreshAffected(srcLoc ? [srcLoc, plan.dst] : [plan.dst]);
    } else {
      showToast(`Move failed: ${formatErr(r.error)}`);
    }
  }, [dialog, openDialog, closeDialog, refreshAffected, showToast]);

  // 새 연결 다이얼로그 — 호스트 더블클릭 시 alias 가 들어옴, 닫으면 null.
  const [dialogAlias, setDialogAlias] = useState<string | null>(null);

  const onHostActivate = useCallback((alias: string) => {
    setDialogAlias(alias);
  }, []);

  /** 연결 성공 후 해당 패널을 SSH 위치로 이동. */
  const onConnected = useCallback(
    async (paneId: PaneId, connectionId: ConnectionId, alias: string) => {
      const state = usePanes.getState();
      const ssh: import("@/types/bindings").SourceId = {
        kind: "ssh",
        connection_id: connectionId,
        // host_ip 는 백엔드 권한 — 다음 connection_list 폴링 또는
        // connection:state 이벤트(Task 11) 에서 갱신. UI 식별만 신경.
        host_ip: "",
        // user 는 connections store 에서 가져와야 정확하지만, 여기서는
        // setEntries 호출 시 location 만 update — backend 가 connection_id 로
        // 라우팅하므로 user 정확성은 same-host 판정에만 영향.
        user: "",
      };
      // 초기 경로: "/" — SSH 호스트의 루트. 권한 없으면 사용자가 PathBar 로 이동.
      // (사용자 home 자동 이동은 ssh_home_directory command 추가 후 — 후속.)
      const location = { source: ssh, path: "/" };
      try {
        const entries = await listDirectory(location);
        state.setEntries(paneId, location, sortEntries(entries));
        state.setActivePane(paneId);
      } catch {
        // useTauri 가 error state 에 저장. 사용자는 빈 패널로 떨어지므로
        // PathBar 로 다른 경로 시도 가능.
      }
      // alias 는 future debug 용으로만 받음 — store 업데이트는 dialog 가 이미.
      void alias;
    },
    [listDirectory, sortEntries],
  );

  // 부트스트랩: 양쪽 패널 초기 로드 (home 디렉토리, Windows 호환)
  useEffect(() => {
    (async () => {
      const result = await commands.homeDirectory();
      const home = result.status === "ok" ? result.data : "/";
      await navigate("left", home);
      await navigate("right", home);
    })();
    // navigate가 deps에 들어가면 무한 루프 — 마운트 1회만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-base text-fg">
      <header className="flex h-9 items-center justify-between border-b border-border px-3">
        <span className="text-title font-medium">duet</span>
      </header>

      <main className="flex flex-1 min-h-0 gap-0">
        <Sidebar onHostActivate={onHostActivate} />
        <Pane id="left" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh} />
        <Pane id="right" onNavigate={navigate} onActivate={onActivate} onRefresh={onRefresh} />
      </main>

      <StatusBar />

      <ConnectionDialog
        alias={dialogAlias}
        onClose={() => setDialogAlias(null)}
        onConnected={onConnected}
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
            />
          }
          ctaLabel="Move"
          ctaTone="neutral"
          onCancel={closeDialog}
          onConfirm={onMoveConfirm}
        />
      )}
      {dialog.kind === "progress" && <ProgressModal title={dialog.title} />}
      {dialog.kind === "settings" && <SettingsDialog onClose={closeDialog} />}
      <Toast />
    </div>
  );
}

function CopyOrMovePlanBody({
  count,
  totalSize,
  dstPath,
  conflicts,
}: {
  count: number;
  totalSize: number;
  dstPath: string;
  conflicts: number;
}) {
  return (
    <div className="space-y-1">
      <div>
        {count} item(s), {formatSize(totalSize)} → <span className="font-mono">{dstPath}</span>
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

export default App;
