import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

/**
 * 앱 글리프 — 실제 OS 아이콘이 있으면 `<img>`, 없으면 이름 첫 글자 모노그램.
 * 아이콘 추출(backend)이 들어오면 `app.icon`(data URL) 만 채우면 자동 전환.
 */
function AppGlyph({ app, px }: { app: AppItem; px: number }) {
  const icon = (app as AppItem & { icon?: string | null }).icon;
  if (icon) {
    return (
      <img
        src={icon}
        alt=""
        width={px}
        height={px}
        draggable={false}
        className="pointer-events-none shrink-0 object-contain"
        style={{ width: px, height: px }}
      />
    );
  }
  return (
    <span
      className="pointer-events-none select-none font-semibold leading-none"
      style={{ fontSize: Math.round(px * 0.6) }}
    >
      {app.name.charAt(0).toUpperCase()}
    </span>
  );
}

function openArgsDialog(app: AppItem): void {
  useUIDialogs
    .getState()
    .open({ kind: "app-args", appId: app.id, name: app.name, args: app.args ?? [] });
}

/** 우클릭 메뉴 구성 — 앱 공통(실행/인자/이름변경/[폴더밖]/제거). */
function appMenu(app: AppItem, folderId?: string): MenuEntry[] {
  const args = app.args ?? [];
  return [
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
      ? [
          {
            id: "out",
            label: "Move out of folder",
            onSelect: () => void moveOutOfFolder(app.id, folderId),
          },
        ]
      : []),
    { kind: "separator" as const },
    { id: "remove", label: "Remove", danger: true, onSelect: () => void removeAppLauncher(app.id) },
  ];
}

/** 단일 앱 버튼(스트립 타일) — 클릭 실행(인자 포함), 우클릭 메뉴. */
function AppButton({
  app,
  merge,
  dragging,
  onMouseDown,
}: {
  app: AppItem;
  merge?: boolean;
  dragging?: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  const args = app.args ?? [];
  return (
    <button
      type="button"
      data-reorder-key={app.id}
      data-reorder-group="apps"
      onMouseDown={onMouseDown}
      onClick={() => void launchApp(String(app.path), args)}
      onContextMenu={(e) => {
        e.preventDefault();
        useContextMenu.getState().openAt(e.clientX, e.clientY, appMenu(app));
      }}
      title={`${app.name}${args.length ? ` ${args.join(" ")}` : ""}\n${app.path}`}
      className={clsx(tileBase, mergeCls(!!merge, !!dragging))}
    >
      <AppGlyph app={app} px={16} />
    </button>
  );
}

/** 폴더 타일 — 자식 첫 4개 미니그리드. 클릭 = 플라이아웃(포털), 우클릭 = 이름변경/해체. */
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
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
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
    <div className="shrink-0">
      <button
        ref={btnRef}
        type="button"
        data-reorder-key={folder.id}
        data-reorder-group="apps"
        onMouseDown={onMouseDown}
        onClick={() => setFlyoutOpen((o) => !o)}
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
              className="flex h-2.5 w-2.5 items-center justify-center overflow-hidden rounded-[2px] bg-base"
            >
              <AppGlyph app={c} px={8} />
            </span>
          ))}
        </span>
      </button>
      {flyoutOpen && (
        <FolderFlyout
          folder={folder}
          anchor={btnRef.current}
          onClose={() => setFlyoutOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 폴더 플라이아웃 — 모바일 런처 그룹창 스타일. 포털로 body 에 렌더해
 * 상단바 `overflow-hidden` 클리핑을 회피(앵커 버튼 rect 기준 fixed 배치).
 */
function FolderFlyout({
  folder,
  anchor,
  onClose,
}: {
  folder: AppItem;
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const children = folder.children ?? [];

  // 마운트 후 카드 크기 측정 → 앵커 아래, 뷰포트 안으로 클램프
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!anchor || !card) return;
    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const left = Math.max(8, Math.min(a.left, window.innerWidth - c.width - 8));
    const top = Math.min(a.bottom + 6, window.innerHeight - c.height - 8);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} />
      <div
        ref={cardRef}
        className="fixed z-50 rounded-xl border border-border bg-base p-3 shadow-panel"
        style={{
          left: pos?.left ?? -9999,
          top: pos?.top ?? -9999,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        <div className="mb-2 px-1 text-meta font-medium text-fg-muted">{folder.name}</div>
        <div className="grid max-w-[18rem] grid-cols-4 gap-1">
          {children.map((c) => (
            <FolderChild key={c.id} app={c} folderId={folder.id} onLaunched={onClose} />
          ))}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** 폴더 플라이아웃 셀 — 아이콘 타일 + 이름. 클릭 실행, 우클릭 메뉴. */
function FolderChild({
  app,
  folderId,
  onLaunched,
}: {
  app: AppItem;
  folderId: string;
  onLaunched: () => void;
}) {
  const args = app.args ?? [];
  return (
    <button
      type="button"
      onClick={() => {
        void launchApp(String(app.path), args);
        onLaunched();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        useContextMenu.getState().openAt(e.clientX, e.clientY, appMenu(app, folderId));
      }}
      title={`${app.name}${args.length ? ` ${args.join(" ")}` : ""}\n${app.path}`}
      className="group flex w-16 flex-col items-center gap-1 rounded-lg p-1.5 hover:bg-subtle"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-subtle text-fg group-hover:bg-base">
        <AppGlyph app={app} px={20} />
      </span>
      <span className="w-full truncate text-center text-meta text-fg-muted">{app.name}</span>
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
