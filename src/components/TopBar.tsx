import { PanelLeft, PanelRight, Plus, Search, Command, Settings } from "lucide-react";
import clsx from "clsx";
import { useUI } from "@/stores/ui";
import { usePanes, activeTab } from "@/stores/panes";
import { usePalette } from "@/stores/palette";
import { useSearch } from "@/stores/search";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { AppLauncherStrip } from "@/components/AppLauncherStrip";

/**
 * 글로벌 상단 툴바 — 모든 패널 공통 컨트롤(창 전역 상태/액션)만.
 * 패널별 컨트롤(뒤로/위로/정렬/뷰모드 등)은 PaneToolbar 유지.
 * 액션은 기존 store/command 를 그대로 호출 — 키바인딩과 동기(하드코딩 X).
 */
export function TopBar() {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const previewOpen = useUI((s) => s.previewOpen);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const togglePreview = useUI((s) => s.togglePreview);

  const newTab = () => usePanes.getState().openTab(usePanes.getState().activePane);
  const openSearch = () => {
    const id = usePanes.getState().activePane;
    useSearch.getState().open(id, activeTab(usePanes.getState(), id).location);
  };

  return (
    <header className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2">
      <span className="px-1 text-title font-medium">duet</span>
      <Divider />
      <IconBtn label="Toggle sidebar (Ctrl+B)" active={sidebarOpen} onClick={toggleSidebar}>
        <PanelLeft size={14} />
      </IconBtn>
      <IconBtn label="Toggle preview (F11)" active={previewOpen} onClick={togglePreview}>
        <PanelRight size={14} />
      </IconBtn>
      <IconBtn label="New tab (Ctrl+T)" onClick={newTab}>
        <Plus size={14} />
      </IconBtn>

      <div className="mx-2 flex min-w-0 flex-1 items-center overflow-hidden">
        <AppLauncherStrip />
      </div>

      <IconBtn label="Search (Ctrl+Shift+F)" onClick={openSearch}>
        <Search size={14} />
      </IconBtn>
      <IconBtn label="Command palette (Ctrl+P)" onClick={() => usePalette.getState().open()}>
        <Command size={14} />
      </IconBtn>
      <IconBtn
        label="Settings (Ctrl+,)"
        onClick={() => useUIDialogs.getState().open({ kind: "settings" })}
      >
        <Settings size={14} />
      </IconBtn>
    </header>
  );
}

function IconBtn({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-subtle",
        active ? "text-accent" : "text-fg-muted hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-border" />;
}
