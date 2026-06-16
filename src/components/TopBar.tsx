import { useEffect, useState } from "react";
import { PanelLeft, PanelRight, Search, Command, Settings, FolderGit2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import clsx from "clsx";
import { useUI } from "@/stores/ui";
import { usePanes, activeTab } from "@/stores/panes";
import { usePalette } from "@/stores/palette";
import { useSearch } from "@/stores/search";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { triggerCompare } from "@/lib/fileActions";
import { AppLauncherStrip } from "@/components/AppLauncherStrip";

/**
 * 글로벌 상단 툴바 — 모든 패널 공통 컨트롤(창 전역 상태/액션)만.
 * 패널별 컨트롤(뒤로/위로/정렬/뷰모드 등)은 PaneToolbar 유지.
 * 액션은 기존 store/command 를 그대로 호출 — 키바인딩과 동기(하드코딩 X).
 *
 * 네이티브 타이틀바(decorations:false)를 대체 — 헤더 빈 영역은 드래그 영역
 * (data-tauri-drag-region), 우측에 최소화/최대화/닫기 커스텀 컨트롤.
 */
export function TopBar() {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const previewOpen = useUI((s) => s.previewOpen);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const togglePreview = useUI((s) => s.togglePreview);

  const openSearch = () => {
    const id = usePanes.getState().activePane;
    useSearch.getState().open(id, activeTab(usePanes.getState(), id).location);
  };

  return (
    <header
      data-tauri-drag-region
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-2"
    >
      {/* 로고/워드마크 — 자식은 pointer-events-none 으로 span 이 드래그 타깃이 되게 */}
      <span
        data-tauri-drag-region
        className="flex select-none items-center gap-1.5 px-1"
        title="duet"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="pointer-events-none shrink-0"
        >
          <rect x="1.5" y="3" width="5.4" height="10" rx="1.6" className="fill-accent" opacity="0.5" />
          <rect x="9.1" y="3" width="5.4" height="10" rx="1.6" className="fill-accent" />
        </svg>
        <span className="pointer-events-none font-brand text-title font-semibold tracking-tight text-fg">
          duet
        </span>
      </span>
      <Divider />
      <IconBtn label="Toggle sidebar (Ctrl+B)" active={sidebarOpen} onClick={toggleSidebar}>
        <PanelLeft size={14} />
      </IconBtn>
      <IconBtn label="Toggle preview (F11)" active={previewOpen} onClick={togglePreview}>
        <PanelRight size={14} />
      </IconBtn>
      <IconBtn
        label="Compare folders (left ↔ right)"
        onClick={() => void triggerCompare(useUIDialogs.getState().open, useToast.getState().show)}
      >
        <FolderGit2 size={14} />
      </IconBtn>

      <div
        data-tauri-drag-region
        className="mx-2 flex min-w-0 flex-1 items-center overflow-hidden"
      >
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

      <Divider />
      <WindowControls />
    </header>
  );
}

/** 우측 창 컨트롤 — 최소화 / 최대화·복원 / 닫기 (Windows/VS Code 스타일). */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    try {
      const win = getCurrentWindow();
      void win.isMaximized().then(setMaximized);
      void win
        .onResized(() => {
          void win.isMaximized().then(setMaximized);
        })
        .then((u) => {
          unlisten = u;
        });
    } catch {
      // Tauri 컨텍스트 밖(테스트 등) — 무시
    }
    return () => unlisten?.();
  }, []);

  const run = (fn: (win: ReturnType<typeof getCurrentWindow>) => Promise<unknown>) => {
    try {
      void fn(getCurrentWindow());
    } catch {
      // no-op
    }
  };

  return (
    // -mr-2 로 헤더 우측 패딩을 상쇄해 화면 가장자리까지 flush
    <div className="-mr-2 flex h-9 items-center">
      <WinBtn label="Minimize" onClick={() => run((w) => w.minimize())}>
        <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
          <line x1="1.5" y1="5.5" x2="9.5" y2="5.5" />
        </svg>
      </WinBtn>
      <WinBtn
        label={maximized ? "Restore" : "Maximize"}
        onClick={() => run((w) => w.toggleMaximize())}
      >
        {maximized ? (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
            <rect x="1" y="3" width="6" height="6" />
            <path d="M3 3 V1 H10 V8 H8" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
            <rect x="1.5" y="1.5" width="8" height="8" />
          </svg>
        )}
      </WinBtn>
      <WinBtn label="Close" danger onClick={() => run((w) => w.close())}>
        <svg width="11" height="11" viewBox="0 0 11 11" stroke="currentColor" strokeWidth="1.1" aria-hidden="true">
          <line x1="1.5" y1="1.5" x2="9.5" y2="9.5" />
          <line x1="9.5" y1="1.5" x2="1.5" y2="9.5" />
        </svg>
      </WinBtn>
    </div>
  );
}

function WinBtn({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
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
        "flex h-9 w-11 items-center justify-center text-fg-muted transition-colors",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-subtle hover:text-fg",
      )}
    >
      {children}
    </button>
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
