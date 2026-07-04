import {
  FolderPlus,
  Copy,
  MoveRight,
  Trash2,
  List,
  LayoutGrid,
  Rows3,
  Eye,
  EyeOff,
  FolderSync,
} from "lucide-react";
import clsx from "clsx";
import { useTranslation } from "react-i18next";
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
} from "@/lib/fileActions";

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
  const { t } = useTranslation();
  const viewMode = usePanes((s) => activeTab(s, id).viewMode);
  const showHidden = usePanes((s) => activeTab(s, id).showHidden);
  const setViewMode = usePanes((s) => s.setViewMode);
  const toggleShowHidden = usePanes((s) => s.toggleShowHidden);
  const syncBrowse = useUI((s) => s.syncBrowse);
  const toggleSyncBrowse = useUI((s) => s.toggleSyncBrowse);
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
      <ToolButton label={t("toolbar.newFolder")} onClick={() => triggerMkdir(open)}>
        <FolderPlus size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.copy")}
        onClick={() => void triggerCopy(open, showToast)}
      >
        <Copy size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.move")}
        onClick={() => void triggerMove(open, showToast)}
      >
        <MoveRight size={15} />
      </ToolButton>
      <ToolButton
        label={t("toolbar.deleteTrash")}
        onClick={() => void triggerDelete("trash", open, showToast)}
      >
        <Trash2 size={15} />
      </ToolButton>

      <div className="flex-1" />

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

      <ToolButton
        label={syncBrowse ? t("toolbar.syncBrowseOn") : t("toolbar.syncBrowseOff")}
        active={syncBrowse}
        onClick={() => toggleSyncBrowse()}
      >
        <FolderSync size={15} />
      </ToolButton>
      <ToolButton
        label={showHidden ? t("toolbar.hideHidden") : t("toolbar.showHidden")}
        active={showHidden}
        onClick={() => toggleShowHidden(id)}
      >
        {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
      </ToolButton>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-4 w-px bg-border" />;
}

interface ToolButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex h-7 w-7 items-center justify-center rounded-panel transition-colors",
        "hover:bg-subtle disabled:opacity-30 disabled:hover:bg-transparent",
        active ? "text-accent" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
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
