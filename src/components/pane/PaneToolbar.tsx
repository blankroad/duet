import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import {
  FolderPlus,
  FilePlus2,
  Copy,
  MoveRight,
  Trash2,
  List,
  LayoutGrid,
  Rows3,
  Eye,
  EyeOff,
  FolderSync,
  Check,
  ChevronDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useKeyHint } from "@/lib/keyHint";
import {
  usePanes,
  activeTab,
  type PaneId,
  type ViewMode,
} from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import {
  triggerCopy,
  triggerDelete,
  triggerMove,
  triggerMkdir,
  triggerNewFile,
} from "@/lib/fileActions";

import { isVirtualTrash } from "@/lib/trashView";
import { ToolButton } from "./ToolButton";
import clsx from "clsx";

interface PaneToolbarProps {
  id: PaneId;
}

/**
 * 패널 액션 바 — 마우스 사용자용 파일 작업 + 뷰 모드.
 *
 * 네비게이션(뒤로/앞으로/위/새로고침)과 새 탭은 PathBar / TabBar 에 있으므로
 * 여기엔 중복 배치하지 않는다 (역할 분리: PathBar=어디+이동, 이 바=무엇을+보기).
 * 모든 액션은 키보드와 동일 경로(파괴적 액션 lib/fileActions, 뷰/hidden panes store).
 */
export function PaneToolbar({ id }: PaneToolbarProps) {
  const kNewFile = useKeyHint("file.newFile");
  const canCreate = usePanes((s) => !isVirtualTrash(activeTab(s, id).location));
  const kNewFolder = useKeyHint("file.newFolder");
  const kCopy = useKeyHint("file.copy");
  const kMove = useKeyHint("file.move");
  const kDelete = useKeyHint("file.delete");
  const kHidden = useKeyHint("view.toggleHidden");
  const { t } = useTranslation();
  const viewMode = usePanes((s) => activeTab(s, id).viewMode);
  const showHidden = usePanes((s) => activeTab(s, id).showHidden);
  const setViewMode = usePanes((s) => s.setViewMode);
  const toggleShowHidden = usePanes((s) => s.toggleShowHidden);
  const syncBrowse = useUI((s) => s.syncBrowse);
  const toggleSyncBrowse = useUI((s) => s.toggleSyncBrowse);
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  const runHere = (action: () => void) => {
    usePanes.getState().setActivePane(id);
    action();
  };
  const openViewMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    usePanes.getState().setActivePane(id);
    const entries: MenuEntry[] = [
      ...(["details", "grid", "tiles"] as const).map((mode) => ({
        id: mode,
        label: t(
          mode === "details"
            ? "toolbar.viewDetails"
            : mode === "grid"
              ? "toolbar.viewGrid"
              : "toolbar.viewTiles",
        ),
        icon:
          mode === viewMode ? <Check size={14} /> : <span className="w-3.5" />,
        onSelect: () => runHere(() => setViewMode(id, mode)),
      })),
      { kind: "separator" },
      {
        id: "sync",
        label: t(syncBrowse ? "toolbar.syncBrowseOn" : "toolbar.syncBrowseOff"),
        icon: syncBrowse ? <Check size={14} /> : <FolderSync size={14} />,
        onSelect: () => runHere(toggleSyncBrowse),
      },
      {
        id: "hidden",
        label: t("menu.toggleHidden"),
        commandId: "view.toggleHidden",
        icon: showHidden ? <Check size={14} /> : <EyeOff size={14} />,
        onSelect: () => runHere(() => toggleShowHidden(id)),
      },
    ];
    useContextMenu.getState().openAt(rect.left, rect.bottom + 4, entries);
  };

  return (
    <div className="flex h-8 shrink-0 items-center min-w-0 gap-0.5 border-b border-border px-1.5">
      <ToolButton
        disabled={!canCreate}
        label={t("toolbar.newFolder", { key: kNewFolder })}
        onClick={() => runHere(() => triggerMkdir(open))}
        shortLabel={t("menu.newFolder")}
        alwaysLabel
      >
        <FolderPlus size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.newFile", { key: kNewFile })}
        disabled={!canCreate}
        onClick={() => runHere(() => triggerNewFile(open))}
        shortLabel={t("menu.newFile")}
        alwaysLabel
      >
        <FilePlus2 size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.copy", { key: kCopy })}
        onClick={() => runHere(() => void triggerCopy(open, showToast))}
        shortLabel={t("menu.copy")}
      >
        <Copy size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.move", { key: kMove })}
        onClick={() => runHere(() => void triggerMove(open, showToast))}
        shortLabel={t("shelf.move")}
      >
        <MoveRight size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.deleteTrash", { key: kDelete })}
        onClick={() =>
          runHere(() => void triggerDelete("trash", open, showToast))
        }
        shortLabel={t("menu.delete")}
      >
        <Trash2 size={15} />
      </ToolButton>

      <div className="flex-1" />

      <div className="toolbar-view-buttons items-center gap-0.5">
        <ViewButton
          label={t("toolbar.viewDetails")}
          mode="details"
          current={viewMode}
          onClick={() => setViewMode(id, "details")}
        >
          <List size={15} />
        </ViewButton>
        <ViewButton
          label={t("toolbar.viewGrid")}
          mode="grid"
          current={viewMode}
          onClick={() => setViewMode(id, "grid")}
        >
          <LayoutGrid size={15} />
        </ViewButton>
        <ViewButton
          label={t("toolbar.viewTiles")}
          mode="tiles"
          current={viewMode}
          onClick={() => setViewMode(id, "tiles")}
        >
          <Rows3 size={15} />
        </ViewButton>

        <Divider />
      </div>
      {/* 동기화: 넓으면 항상, 좁아도 켜져 있으면 보인다 (켜진 걸 잊으면 반대 패널이 같이 움직인다). */}
      <ToolButton
        className={clsx("toolbar-sync", syncBrowse && "toolbar-sync-on")}
        label={
          syncBrowse ? t("toolbar.syncBrowseOn") : t("toolbar.syncBrowseOff")
        }
        ariaLabel={t("toolbar.syncBrowse")}
        active={syncBrowse}
        onClick={() => runHere(toggleSyncBrowse)}
      >
        <FolderSync size={15} />
      </ToolButton>
      {/* 숨김 파일: 모든 폭에서 1클릭 (보기 메뉴에도 남긴다). */}
      <ToolButton
        label={
          showHidden
            ? t("toolbar.hideHidden", { key: kHidden })
            : t("toolbar.showHidden", { key: kHidden })
        }
        ariaLabel={t("toolbar.hiddenFiles")}
        active={showHidden}
        onClick={() => runHere(() => toggleShowHidden(id))}
      >
        {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
      </ToolButton>
      <button
        type="button"
        className="toolbar-view-menu h-7 shrink-0 items-center gap-1 rounded-panel px-1.5 text-fg-muted hover:bg-subtle hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        onClick={openViewMenu}
        aria-haspopup="menu"
        aria-label={t("toolbar.viewOptions")}
        title={t("toolbar.viewOptions")}
      >
        {viewMode === "details" ? (
          <List size={15} />
        ) : viewMode === "grid" ? (
          <LayoutGrid size={15} />
        ) : (
          <Rows3 size={15} />
        )}
        <span className="toolbar-view-menu-label">
          {t("toolbar.viewOptions")}
        </span>
        <ChevronDown size={12} />
      </button>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-border" />;
}

function ViewButton({
  label,
  mode,
  current,
  onClick,
  children,
}: {
  label: string;
  mode: ViewMode;
  current: ViewMode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <ToolButton label={label} active={current === mode} onClick={onClick}>
      {children}
    </ToolButton>
  );
}
