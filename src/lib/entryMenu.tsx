import {
  FolderOpen,
  PanelRight,
  Copy,
  FolderInput,
  Pencil,
  FolderPlus,
  Star,
  Heart,
  ClipboardCopy,
  ClipboardPaste,
  Scissors,
  Trash2,
  Trash,
  RotateCw,
  LayoutGrid,
  ArrowDownUp,
  Eye,
  ExternalLink,
  FilePen,
  FolderSearch,
  FileArchive,
  Package,
  Undo2,
  FolderSync,
  FolderGit2,
  Terminal,
  Columns3,
  Layers,
  Sigma,
  Hash,
  Lock,
  Link2,
} from "lucide-react";
import i18n from "@/i18n";
import { commands } from "@/types/bindings";
import type { Entry, Location } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { basename } from "@/lib/paths";
import { isArchiveName } from "@/lib/archive";
import {
  usePanes,
  type PaneId,
  type SortKey,
  type ViewMode,
} from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useUI } from "@/stores/ui";
import { useToast } from "@/stores/toast";
import { useConnections } from "@/stores/connections";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import { addHostFavorite } from "@/stores/hostFavorites";
import { childLocation } from "@/lib/entryDnd";
import { calcDirSizes } from "@/lib/dirSize";
import { isWindows } from "@/lib/fileIcon";
import {
  triggerCopy,
  triggerMove,
  triggerRename,
  triggerBatchRename,
  triggerMkdir,
  triggerDelete,
  triggerExtract,
  triggerCompress,
  triggerChecksum,
  triggerPermissions,
  triggerNewSymlink,
  triggerSync,
  triggerCompare,
  copyPathsOf,
  clipCopy,
  clipCut,
  clipPaste,
  addSelectionToShelf,
} from "@/lib/fileActions";
import { useClipboard } from "@/stores/clipboard";
import type { MenuEntry } from "@/stores/contextMenu";

/**
 * 파일 패널 우클릭 메뉴 항목 빌더. trigger* 는 활성 패널의 선택/cursor 를 대상으로
 * 동작하므로(App.onEntryContextMenu 가 우클릭 전에 activePane/cursor/selection 세팅),
 * 여기서는 전역 store 만 읽어 항목을 구성한다. 네비게이션(navigate)이 필요한
 * Open/Open-in-other-pane/Refresh 만 App 콜백으로 받는다.
 */
export interface EntryMenuDeps {
  paneId: PaneId;
  entry: Entry;
  /** 활성 패널 현재 디렉토리. */
  location: Location;
  /** 선택된 항목 수 (1 = 단일, >1 = 다중). */
  selectedCount: number;
  /** 휴지통 탐색 중이면 true — "Put back" 항목 노출. */
  inTrash?: boolean;
  onActivate: (id: PaneId, entry: Entry) => void;
  onOpenInOtherPane: (id: PaneId, entry: Entry) => void;
  /** 휴지통 항목 원위치 복원. */
  onPutBack?: () => void;
}

const ICON = 13;
const sep = (): MenuEntry => ({ kind: "separator" });

/** ssh 위치면 활성 connection alias 반환, 아니면 null. */
function sshAlias(location: Location): string | null {
  if (location.source.kind !== "ssh") return null;
  const connId = location.source.connection_id;
  const conn = Object.values(useConnections.getState().active).find(
    (c) => c.id === connId,
  );
  return conn?.alias ?? null;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useToast.getState().show(`Copied: ${text}`, "success");
  } catch {
    useToast.getState().show("Clipboard unavailable", "error");
  }
}

/** OS 파일 매니저에서 항목 위치 표시 (로컬 전용). */
async function revealEntry(target: Location): Promise<void> {
  const r = await commands.revealPath(target);
  if (r.status === "error")
    useToast.getState().show(`Reveal failed: ${formatErr(r.error)}`, "error");
}

/** 해당 폴더에서 OS 터미널 열기 (로컬 전용). */
async function openTerminalAt(target: Location): Promise<void> {
  const r = await commands.openTerminal(target);
  if (r.status === "error")
    useToast.getState().show(`Open terminal failed: ${formatErr(r.error)}`, "error");
}

/** 원격 파일을 에디터로 열고 변경 시 자동 재업로드(편집 라운드트립). */
async function editRemoteEntry(target: Location, name: string): Promise<void> {
  const r = await commands.sshEditOpen(target);
  const toast = useToast.getState().show;
  if (r.status === "error") toast(`Edit failed: ${formatErr(r.error)}`);
  else toast(`Editing ${name} — changes auto-upload`);
}

export function buildEntryMenu(deps: EntryMenuDeps): MenuEntry[] {
  const {
    paneId,
    entry,
    location,
    selectedCount,
    inTrash,
    onActivate,
    onOpenInOtherPane,
    onPutBack,
  } = deps;
  const open = useUIDialogs.getState().open;
  const showToast = useToast.getState().show;
  const isDir = entry.kind === "dir";
  const multi = selectedCount > 1;
  const child = childLocation(location, entry.name);
  const alias = sshAlias(location);

  const items: MenuEntry[] = [];

  // 휴지통 탐색 중 — 원위치 복원 우선 노출.
  if (inTrash && onPutBack) {
    items.push(
      {
        id: "put-back",
        label: i18n.t("menu.putBack"),
        icon: <Undo2 size={ICON} />,
        onSelect: onPutBack,
      },
      sep(),
    );
  }

  if (!multi) {
    if (isDir) {
      items.push(
        {
          id: "open",
          label: i18n.t("menu.open"),
          icon: <FolderOpen size={ICON} />,
          shortcut: "Enter",
          onSelect: () => onActivate(paneId, entry),
        },
        {
          id: "open-other",
          label: i18n.t("menu.openInOtherPane"),
          icon: <PanelRight size={ICON} />,
          onSelect: () => onOpenInOtherPane(paneId, entry),
        },
      );
    } else {
      items.push({
        id: "open",
        label: i18n.t("menu.open"),
        icon: <ExternalLink size={ICON} />,
        shortcut: "Enter",
        onSelect: () => onActivate(paneId, entry),
      });
      // 원격 파일: 편집 라운드트립(다운로드→에디터→저장 시 자동 재업로드).
      if (location.source.kind === "ssh") {
        items.push({
          id: "edit-remote",
          label: i18n.t("menu.editAndWatch"),
          icon: <FilePen size={ICON} />,
          onSelect: () => void editRemoteEntry(child, entry.name),
        });
      }
    }
    if (location.source.kind === "local") {
      items.push({
        id: "reveal",
        label: i18n.t("menu.showInFileManager"),
        icon: <FolderSearch size={ICON} />,
        onSelect: () => void revealEntry(child),
      });
      if (isDir) {
        items.push({
          id: "open-terminal",
          label: i18n.t("menu.openTerminalHere"),
          icon: <Terminal size={ICON} />,
          onSelect: () => void openTerminalAt(child),
        });
      }
    }
    items.push(sep());
  }

  if (!isDir && !multi && isArchiveName(entry.name)) {
    items.push(
      {
        id: "extract",
        label: i18n.t("menu.extractHere"),
        icon: <FileArchive size={ICON} />,
        onSelect: () => void triggerExtract(showToast),
      },
      sep(),
    );
  }

  items.push(
    {
      id: "clip-copy",
      label: i18n.t("menu.copy"),
      icon: <Copy size={ICON} />,
      shortcut: "Ctrl+C",
      onSelect: () => clipCopy(showToast),
    },
    {
      id: "clip-cut",
      label: i18n.t("menu.cut"),
      icon: <Scissors size={ICON} />,
      shortcut: "Ctrl+X",
      onSelect: () => clipCut(showToast),
    },
    {
      id: "clip-paste",
      label: i18n.t("menu.pasteIntoFolder"),
      icon: <ClipboardPaste size={ICON} />,
      shortcut: "Ctrl+V",
      disabled: !useClipboard.getState().entry,
      onSelect: () => void clipPaste(open, showToast),
    },
    sep(),
    {
      id: "copy",
      label: i18n.t("menu.copyToOtherPane"),
      icon: <Copy size={ICON} />,
      shortcut: "F5",
      onSelect: () => void triggerCopy(open, showToast),
    },
    {
      id: "move",
      label: i18n.t("menu.moveToOtherPane"),
      icon: <FolderInput size={ICON} />,
      shortcut: "F6",
      onSelect: () => void triggerMove(open, showToast),
    },
    {
      id: "shelf-add",
      label: i18n.t("menu.addToShelf"),
      icon: <Layers size={ICON} />,
      shortcut: "Ctrl+Shift+A",
      onSelect: () => addSelectionToShelf(showToast),
    },
    {
      id: "compress",
      label: i18n.t("menu.compress"),
      icon: <Package size={ICON} />,
      onSelect: () => triggerCompress(open, showToast),
    },
    // 폴더(또는 다중 선택에 폴더 포함 가능성) — 재귀 크기 계산해 크기 컬럼에 표시.
    ...(isDir || multi
      ? [
          {
            id: "calc-size",
            label: i18n.t("menu.calculateSize"),
            icon: <Sigma size={ICON} />,
            shortcut: "Shift+Space",
            onSelect: () => void calcDirSizes(paneId),
          } as MenuEntry,
        ]
      : []),
    // 파일(또는 다중 선택에 파일 포함 가능성) — 무결성 해시 다이얼로그.
    ...(!isDir || multi
      ? [
          {
            id: "checksum",
            label: i18n.t("menu.checksum"),
            icon: <Hash size={ICON} />,
            onSelect: () => triggerChecksum(open, showToast),
          } as MenuEntry,
        ]
      : []),
    // POSIX 권한 편집 — 원격 또는 로컬 unix (Windows 로컬은 POSIX 권한 없음).
    ...(location.source.kind === "ssh" || !isWindows()
      ? [
          {
            id: "permissions",
            label: i18n.t("menu.permissions"),
            icon: <Lock size={ICON} />,
            onSelect: () => triggerPermissions(open, showToast),
          } as MenuEntry,
        ]
      : []),
    sep(),
    {
      id: "rename",
      label: i18n.t("menu.rename"),
      icon: <Pencil size={ICON} />,
      shortcut: "F2",
      disabled: multi,
      onSelect: () => triggerRename(showToast),
    },
    ...(multi
      ? [
          {
            id: "batch-rename",
            label: i18n.t("menu.batchRename"),
            icon: <Pencil size={ICON} />,
            onSelect: () => triggerBatchRename(open, showToast),
          } as MenuEntry,
        ]
      : []),
    {
      id: "mkdir",
      label: i18n.t("menu.newFolder"),
      icon: <FolderPlus size={ICON} />,
      shortcut: "F7",
      onSelect: () => triggerMkdir(open),
    },
    {
      id: "bookmark",
      label: i18n.t("menu.addToBookmarks"),
      icon: <Star size={ICON} />,
      onSelect: () => void bookmarkLocation(child, entry.name),
    },
  );

  if (alias) {
    items.push({
      id: "host-fav",
      label: i18n.t("menu.addToHostFavorites"),
      icon: <Heart size={ICON} />,
      onSelect: () =>
        void addHostFavorite(alias, entry.name, String(child.path)),
    });
  }

  items.push(
    {
      id: "copy-path",
      label: i18n.t("menu.copyPath"),
      icon: <ClipboardCopy size={ICON} />,
      // 로컬은 백엔드 Path::join 으로 — Windows 드라이브문자·네이티브 구분자 보존(§7).
      onSelect: () =>
        void copyPathsOf([{ location, name: entry.name }], showToast),
    },
    {
      id: "copy-name",
      label: i18n.t("menu.copyName"),
      onSelect: () => void copyText(entry.name),
    },
    sep(),
    {
      id: "delete",
      label: i18n.t("menu.delete"),
      icon: <Trash2 size={ICON} />,
      shortcut: "Del",
      danger: true,
      onSelect: () => void triggerDelete("trash", open, showToast),
    },
    {
      id: "delete-perm",
      label: i18n.t("menu.deletePermanently"),
      icon: <Trash size={ICON} />,
      shortcut: "Shift+Del",
      danger: true,
      onSelect: () => void triggerDelete("permanent", open, showToast),
    },
  );

  return items;
}

export interface EmptyMenuDeps {
  paneId: PaneId;
  location: Location;
  onRefresh: (id: PaneId) => void;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: i18n.t("menu.sortName") },
  { key: "size", label: i18n.t("menu.sortSize") },
  { key: "mtime", label: i18n.t("menu.sortMtime") },
  { key: "kind", label: i18n.t("menu.sortKind") },
  { key: "ext", label: i18n.t("menu.sortExt") },
];
const VIEWS: { mode: ViewMode; label: string }[] = [
  { mode: "details", label: i18n.t("menu.viewDetails") },
  { mode: "grid", label: i18n.t("menu.viewGrid") },
  { mode: "tiles", label: i18n.t("menu.viewTiles") },
];

export function buildEmptyMenu(deps: EmptyMenuDeps): MenuEntry[] {
  const { paneId, location, onRefresh } = deps;
  const open = useUIDialogs.getState().open;
  const p = usePanes.getState();
  const alias = sshAlias(location);

  const items: MenuEntry[] = [
    {
      id: "paste",
      label: i18n.t("menu.paste"),
      icon: <ClipboardPaste size={ICON} />,
      shortcut: "Ctrl+V",
      disabled: !useClipboard.getState().entry,
      onSelect: () => void clipPaste(open, useToast.getState().show),
    },
    {
      id: "mkdir",
      label: i18n.t("menu.newFolder"),
      icon: <FolderPlus size={ICON} />,
      shortcut: "F7",
      onSelect: () => triggerMkdir(open),
    },
    // 심볼릭 링크 — 원격 또는 로컬 unix (Windows 로컬은 권한 필요라 미지원).
    ...(location.source.kind === "ssh" || !isWindows()
      ? [
          {
            id: "symlink",
            label: i18n.t("menu.newSymlink"),
            icon: <Link2 size={ICON} />,
            onSelect: () => triggerNewSymlink(open),
          } as MenuEntry,
        ]
      : []),
    {
      id: "refresh",
      label: i18n.t("menu.refresh"),
      icon: <RotateCw size={ICON} />,
      shortcut: "Ctrl+R",
      onSelect: () => onRefresh(paneId),
    },
    ...(location.source.kind === "local"
      ? [
          {
            id: "open-terminal",
            label: i18n.t("menu.openTerminalHere"),
            icon: <Terminal size={ICON} />,
            onSelect: () => void openTerminalAt(location),
          } as MenuEntry,
        ]
      : []),
    {
      id: "sync",
      label: i18n.t("menu.syncToOtherPane"),
      icon: <FolderSync size={ICON} />,
      onSelect: () => void triggerSync(open, useToast.getState().show),
    },
    {
      id: "compare",
      label: i18n.t("menu.compareFolders"),
      icon: <FolderGit2 size={ICON} />,
      onSelect: () => void triggerCompare(open, useToast.getState().show),
    },
    sep(),
    {
      id: "view",
      label: i18n.t("menu.viewAs"),
      icon: <LayoutGrid size={ICON} />,
      children: VIEWS.map((v) => ({
        id: `view-${v.mode}`,
        label: v.label,
        onSelect: () => p.setViewMode(paneId, v.mode),
      })),
    },
    {
      id: "sort",
      label: i18n.t("menu.sortBy"),
      icon: <ArrowDownUp size={ICON} />,
      children: SORTS.map((s) => ({
        id: `sort-${s.key}`,
        label: s.label,
        onSelect: () => p.toggleSortKey(paneId, s.key),
      })),
    },
    {
      id: "hidden",
      label: i18n.t("menu.toggleHidden"),
      icon: <Eye size={ICON} />,
      shortcut: "Ctrl+H",
      onSelect: () => p.toggleShowHidden(paneId),
    },
    {
      id: "split-ext",
      label: useUI.getState().splitExt
        ? "Hide extension column"
        : "Show extension column",
      icon: <Columns3 size={ICON} />,
      onSelect: () => useUI.getState().toggleSplitExt(),
    },
    sep(),
    {
      id: "bookmark",
      label: i18n.t("menu.addFolderBookmarks"),
      icon: <Star size={ICON} />,
      onSelect: () => void bookmarkLocation(location, folderName(location)),
    },
  ];

  if (alias) {
    items.push({
      id: "host-fav",
      label: i18n.t("menu.addFolderHostFavorites"),
      icon: <Heart size={ICON} />,
      onSelect: () =>
        void addHostFavorite(
          alias,
          folderName(location),
          String(location.path),
        ),
    });
  }

  return items;
}

/** location 경로의 basename (북마크 기본 이름). */
export function folderName(location: Location): string {
  return basename(String(location.path));
}
