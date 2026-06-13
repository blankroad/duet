import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCw,
  FolderPlus,
  Copy,
  Scissors,
  Trash2,
  List,
  LayoutGrid,
  Rows3,
  Eye,
  EyeOff,
  PanelRight,
} from "lucide-react";
import clsx from "clsx";
import { usePanes, activeTab, type PaneId, type ViewMode } from "@/stores/panes";
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
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
}

/**
 * 패널 상단 커맨드 바 — 마우스 사용자용. 모든 액션은 키보드와 동일 경로
 * (파괴적 액션은 lib/fileActions, 뷰/hidden 은 panes store, preview 는 ui store).
 * 절제형: 아이콘 버튼, 강조색 남용 금지 (활성 뷰만 accent).
 */
export function PaneToolbar({
  id,
  canBack,
  canForward,
  onBack,
  onForward,
  onUp,
  onRefresh,
}: PaneToolbarProps) {
  const viewMode = usePanes((s) => activeTab(s, id).viewMode);
  const showHidden = usePanes((s) => activeTab(s, id).showHidden);
  const setViewMode = usePanes((s) => s.setViewMode);
  const toggleShowHidden = usePanes((s) => s.toggleShowHidden);
  const previewOpen = useUI((s) => s.previewOpen);
  const togglePreview = useUI((s) => s.togglePreview);
  const open = useUIDialogs((s) => s.open);
  const showToast = useToast((s) => s.show);

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
      <ToolButton label="Back" disabled={!canBack} onClick={onBack}>
        <ArrowLeft size={15} />
      </ToolButton>
      <ToolButton label="Forward" disabled={!canForward} onClick={onForward}>
        <ArrowRight size={15} />
      </ToolButton>
      <ToolButton label="Up" onClick={onUp}>
        <ArrowUp size={15} />
      </ToolButton>
      <ToolButton label="Refresh" onClick={onRefresh}>
        <RefreshCw size={14} />
      </ToolButton>

      <Divider />

      <ToolButton label="New folder (F7)" onClick={() => triggerMkdir(open)}>
        <FolderPlus size={15} />
      </ToolButton>
      <ToolButton label="Copy → other pane (F5)" onClick={() => void triggerCopy(open, showToast)}>
        <Copy size={15} />
      </ToolButton>
      <ToolButton label="Move → other pane (F6)" onClick={() => void triggerMove(open, showToast)}>
        <Scissors size={15} />
      </ToolButton>
      <ToolButton
        label="Delete to trash (Del)"
        onClick={() => void triggerDelete("trash", open, showToast)}
      >
        <Trash2 size={15} />
      </ToolButton>

      <div className="flex-1" />

      <ViewButton label="Details" mode="details" current={viewMode} onClick={() => setViewMode(id, "details")}>
        <List size={15} />
      </ViewButton>
      <ViewButton label="Grid" mode="grid" current={viewMode} onClick={() => setViewMode(id, "grid")}>
        <LayoutGrid size={15} />
      </ViewButton>
      <ViewButton label="Tiles" mode="tiles" current={viewMode} onClick={() => setViewMode(id, "tiles")}>
        <Rows3 size={15} />
      </ViewButton>

      <Divider />

      <ToolButton
        label={showHidden ? "Hide hidden files (Ctrl+H)" : "Show hidden files (Ctrl+H)"}
        active={showHidden}
        onClick={() => toggleShowHidden(id)}
      >
        {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
      </ToolButton>
      <ToolButton label="Toggle preview (F11)" active={previewOpen} onClick={() => togglePreview()}>
        <PanelRight size={15} />
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

function ToolButton({ label, active, disabled, onClick, children }: ToolButtonProps) {
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
