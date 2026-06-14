import { Fragment } from "react";
import { Plus } from "lucide-react";
import clsx from "clsx";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppLauncher } from "@/types/bindings";
import {
  useAppLaunchers,
  addAppLauncher,
  renameAppLauncher,
  removeAppLauncher,
  reorderAppLaunchers,
  launchApp,
} from "@/stores/appLaunchers";
import { useReorderable } from "@/hooks/useReorderable";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";

/**
 * 상단 툴바 앱 런처 스트립 — 등록한 앱을 원클릭 실행(Dock 관례). 드래그 재정렬,
 * 우클릭 메뉴(실행/이름변경/제거). `+` 로 파일피커 등록.
 */
export function AppLauncherStrip() {
  const items = useAppLaunchers((s) => s.items);
  const { dragKey, insertBeforeKey, onItemMouseDown } = useReorderable({
    group: "apps",
    keys: items.map((a) => a.id),
    onCommit: (next) => void reorderAppLaunchers(next),
  });

  return (
    <div className="flex items-center gap-0.5 overflow-hidden">
      {items.map((a) => (
        <Fragment key={a.id}>
          {dragKey && insertBeforeKey === a.id && <DropLine />}
          <AppButton
            app={a}
            dragging={dragKey === a.id}
            onMouseDown={(e) => onItemMouseDown(e, a.id)}
          />
        </Fragment>
      ))}
      {dragKey && insertBeforeKey === null && <DropLine />}
      <button
        type="button"
        onClick={() => void registerApp()}
        title="Add application"
        aria-label="Add application"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-subtle hover:text-fg"
      >
        <Plus size={13} />
      </button>
    </div>
  );
}

function AppButton({
  app,
  dragging,
  onMouseDown,
}: {
  app: AppLauncher;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const menu: MenuEntry[] = [
    { id: "launch", label: "Launch", onSelect: () => void launchApp(String(app.path)) },
    {
      id: "rename",
      label: "Rename…",
      onSelect: () => {
        const n = window.prompt("App name", app.name);
        if (n) void renameAppLauncher(app.id, n);
      },
    },
    { kind: "separator" },
    { id: "remove", label: "Remove", danger: true, onSelect: () => void removeAppLauncher(app.id) },
  ];
  return (
    <button
      type="button"
      data-reorder-key={app.id}
      data-reorder-group="apps"
      onMouseDown={onMouseDown}
      onClick={() => void launchApp(String(app.path))}
      onContextMenu={(e) => {
        e.preventDefault();
        useContextMenu.getState().openAt(e.clientX, e.clientY, menu);
      }}
      title={`${app.name} — ${app.path}`}
      className={clsx(
        "flex h-7 w-7 shrink-0 items-center justify-center rounded bg-subtle text-meta font-semibold text-fg hover:bg-border",
        dragging && "opacity-50",
      )}
    >
      {app.name.charAt(0).toUpperCase()}
    </button>
  );
}

function DropLine() {
  return <div className="mx-0.5 h-5 w-0.5 shrink-0 rounded bg-accent" />;
}

/** 파일피커로 앱 선택 → 등록. mac `.app` 은 package 라 file 로 잡힘(directory:false). */
async function registerApp(): Promise<void> {
  const selected = await open({
    title: "Add application",
    multiple: false,
    directory: false,
    defaultPath: "/Applications",
  });
  if (!selected || Array.isArray(selected)) return;
  const base = selected.split("/").pop() ?? selected;
  const name = base.replace(/\.(app|exe|desktop)$/i, "");
  await addAppLauncher(name, selected);
}
