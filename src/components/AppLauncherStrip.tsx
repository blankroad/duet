import { Fragment, useRef, useState } from "react";
import { Plus } from "lucide-react";
import clsx from "clsx";
import { open } from "@tauri-apps/plugin-dialog";
import type { AppItem } from "@/types/bindings";
import {
  useAppLaunchers,
  isAppFolder,
  addAppLauncher,
  renameAppLauncher,
  removeAppLauncher,
  reorderAppLaunchers,
  groupApps,
  moveOutOfFolder,
  dissolveFolder,
  launchApp,
} from "@/stores/appLaunchers";
import { useReorderable } from "@/hooks/useReorderable";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { useUIDialogs } from "@/stores/ui-dialogs";

/**
 * 상단 툴바 앱 런처 스트립 — 등록한 앱 원클릭 실행(Dock). 드래그: 가장자리=재정렬,
 * 중앙(40% 밴드, 300ms)=폴더로 머지. 폴더 클릭 = 플라이아웃. 우클릭 = 인자/이름/제거.
 */
export function AppLauncherStrip() {
  const items = useAppLaunchers((s) => s.items);
  const dragIsFolder = useRef(false);
  const { dragKey, insertBeforeKey, mergeTargetKey, onItemMouseDown } = useReorderable({
    group: "apps",
    keys: items.map((a) => a.id),
    onCommit: (next) => void reorderAppLaunchers(next),
    axis: "x",
    onMerge: (drag, target) => void groupApps(drag, target),
    canMerge: () => !dragIsFolder.current, // 폴더를 끌 때는 머지 금지(재정렬만)
  });

  const startDrag = (e: React.MouseEvent, id: string) => {
    dragIsFolder.current = items.find((i) => i.id === id)?.path == null;
    onItemMouseDown(e, id);
  };

  return (
    <div className="flex items-center gap-0.5 overflow-hidden">
      {items.map((a) => (
        <Fragment key={a.id}>
          {dragKey && insertBeforeKey === a.id && <DropLine />}
          {isAppFolder(a) ? (
            <FolderTile
              folder={a}
              merge={mergeTargetKey === a.id}
              dragging={dragKey === a.id}
              onMouseDown={(e) => startDrag(e, a.id)}
            />
          ) : (
            <AppButton
              app={a}
              merge={mergeTargetKey === a.id}
              dragging={dragKey === a.id}
              onMouseDown={(e) => startDrag(e, a.id)}
            />
          )}
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

const tileBase =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded bg-subtle text-fg hover:bg-border";

function mergeCls(merge: boolean, dragging: boolean): string {
  return clsx(dragging && "opacity-50", merge && "scale-110 ring-2 ring-accent");
}

function openArgsDialog(app: AppItem): void {
  useUIDialogs
    .getState()
    .open({ kind: "app-args", appId: app.id, name: app.name, args: app.args ?? [] });
}

/** 단일 앱 버튼 — 클릭 실행(인자 포함), 우클릭 메뉴. `inFolder` 면 메뉴에 "Move out". */
function AppButton({
  app,
  merge,
  dragging,
  onMouseDown,
  folderId,
}: {
  app: AppItem;
  merge?: boolean;
  dragging?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  folderId?: string;
}) {
  const args = app.args ?? [];
  const menu: MenuEntry[] = [
    { id: "launch", label: "Launch", onSelect: () => void launchApp(String(app.path), args) },
    { id: "args", label: "Edit arguments…", onSelect: () => openArgsDialog(app) },
    {
      id: "rename",
      label: "Rename…",
      onSelect: () => {
        const n = window.prompt("App name", app.name);
        if (n) void renameAppLauncher(app.id, n);
      },
    },
    ...(folderId
      ? [{ id: "out", label: "Move out of folder", onSelect: () => void moveOutOfFolder(app.id, folderId) }]
      : []),
    { kind: "separator" as const },
    { id: "remove", label: "Remove", danger: true, onSelect: () => void removeAppLauncher(app.id) },
  ];
  return (
    <button
      type="button"
      data-reorder-key={app.id}
      data-reorder-group={folderId ? `folder-${folderId}` : "apps"}
      onMouseDown={onMouseDown}
      onClick={() => void launchApp(String(app.path), args)}
      onContextMenu={(e) => {
        e.preventDefault();
        useContextMenu.getState().openAt(e.clientX, e.clientY, menu);
      }}
      title={`${app.name}${args.length ? ` ${args.join(" ")}` : ""}\n${app.path}`}
      className={clsx(tileBase, "text-meta font-semibold", mergeCls(!!merge, !!dragging))}
    >
      {app.name.charAt(0).toUpperCase()}
    </button>
  );
}

/** 폴더 타일 — 자식 첫 4개 미니그리드. 클릭 = 플라이아웃, 우클릭 = 이름변경/해체. */
function FolderTile({
  folder,
  merge,
  dragging,
  onMouseDown,
}: {
  folder: AppItem;
  merge: boolean;
  dragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(false);
  const children = folder.children ?? [];
  const menu: MenuEntry[] = [
    {
      id: "rename",
      label: "Rename folder…",
      onSelect: () => {
        const n = window.prompt("Folder name", folder.name);
        if (n) void renameAppLauncher(folder.id, n);
      },
    },
    { id: "dissolve", label: "Dissolve folder", onSelect: () => void dissolveFolder(folder.id) },
  ];
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        data-reorder-key={folder.id}
        data-reorder-group="apps"
        onMouseDown={onMouseDown}
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault();
          useContextMenu.getState().openAt(e.clientX, e.clientY, menu);
        }}
        title={folder.name}
        className={clsx(tileBase, "p-0.5", mergeCls(merge, dragging))}
      >
        <span className="grid grid-cols-2 grid-rows-2 gap-px">
          {children.slice(0, 4).map((c) => (
            <span
              key={c.id}
              className="flex h-2.5 w-2.5 items-center justify-center rounded-[2px] bg-base text-[7px] font-semibold leading-none text-fg-muted"
            >
              {c.name.charAt(0).toUpperCase()}
            </span>
          ))}
        </span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 rounded-md border border-border bg-base p-2 shadow-lg">
            <div className="mb-1 px-1 text-meta text-fg-muted">{folder.name}</div>
            <div className="flex max-w-[15rem] flex-wrap gap-1">
              {children.map((c) => (
                <FolderChild key={c.id} app={c} folderId={folder.id} />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 폴더 플라이아웃 안의 자식 — 드래그 재정렬/머지 없음(단일 레벨). */
function FolderChild({ app, folderId }: { app: AppItem; folderId: string }) {
  return <AppButton app={app} onMouseDown={() => {}} folderId={folderId} />;
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
