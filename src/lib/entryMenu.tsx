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
  Trash2,
  Trash,
  RotateCw,
  LayoutGrid,
  ArrowDownUp,
  Eye,
  ExternalLink,
  FolderSearch,
  FileArchive,
  Package,
  Undo2,
} from "lucide-react";
import { commands } from "@/types/bindings";
import type { Entry, Location } from "@/types/bindings";
import { formatErr } from "@/lib/error";
import { isArchiveName } from "@/lib/archive";
import { usePanes, type PaneId, type SortKey, type ViewMode } from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { useToast } from "@/stores/toast";
import { useConnections } from "@/stores/connections";
import { bookmarkLocation } from "@/lib/bookmarkActions";
import { addHostFavorite } from "@/stores/hostFavorites";
import { childLocation } from "@/lib/entryDnd";
import { triggerCopy, triggerMove, triggerRename, triggerBatchRename, triggerMkdir, triggerDelete, triggerExtract, triggerCompress } from "@/lib/fileActions";
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
  const conn = Object.values(useConnections.getState().active).find((c) => c.id === connId);
  return conn?.alias ?? null;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useToast.getState().show(`Copied: ${text}`);
  } catch {
    useToast.getState().show("Clipboard unavailable");
  }
}

/** OS 파일 매니저에서 항목 위치 표시 (로컬 전용). */
async function revealEntry(target: Location): Promise<void> {
  const r = await commands.revealPath(target);
  if (r.status === "error") useToast.getState().show(`Reveal failed: ${formatErr(r.error)}`);
}

export function buildEntryMenu(deps: EntryMenuDeps): MenuEntry[] {
  const { paneId, entry, location, selectedCount, inTrash, onActivate, onOpenInOtherPane, onPutBack } = deps;
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
      { id: "put-back", label: "Put back", icon: <Undo2 size={ICON} />, onSelect: onPutBack },
      sep(),
    );
  }

  if (!multi) {
    if (isDir) {
      items.push(
        { id: "open", label: "Open", icon: <FolderOpen size={ICON} />, shortcut: "Enter", onSelect: () => onActivate(paneId, entry) },
        { id: "open-other", label: "Open in other pane", icon: <PanelRight size={ICON} />, onSelect: () => onOpenInOtherPane(paneId, entry) },
      );
    } else {
      items.push({ id: "open", label: "Open", icon: <ExternalLink size={ICON} />, shortcut: "Enter", onSelect: () => onActivate(paneId, entry) });
    }
    if (location.source.kind === "local") {
      items.push({ id: "reveal", label: "Show in file manager", icon: <FolderSearch size={ICON} />, onSelect: () => void revealEntry(child) });
    }
    items.push(sep());
  }

  if (!isDir && !multi && isArchiveName(entry.name)) {
    items.push(
      { id: "extract", label: "Extract here", icon: <FileArchive size={ICON} />, onSelect: () => void triggerExtract(showToast) },
      sep(),
    );
  }

  items.push(
    { id: "copy", label: "Copy to other pane", icon: <Copy size={ICON} />, shortcut: "F5", onSelect: () => void triggerCopy(open, showToast) },
    { id: "move", label: "Move to other pane", icon: <FolderInput size={ICON} />, shortcut: "F6", onSelect: () => void triggerMove(open, showToast) },
    { id: "compress", label: "Compress…", icon: <Package size={ICON} />, onSelect: () => triggerCompress(open, showToast) },
    sep(),
    { id: "rename", label: "Rename", icon: <Pencil size={ICON} />, shortcut: "F2", disabled: multi, onSelect: () => triggerRename(open, showToast) },
    ...(multi
      ? [{ id: "batch-rename", label: "Batch rename…", icon: <Pencil size={ICON} />, onSelect: () => triggerBatchRename(open, showToast) } as MenuEntry]
      : []),
    { id: "mkdir", label: "New folder", icon: <FolderPlus size={ICON} />, shortcut: "F7", onSelect: () => triggerMkdir(open) },
    { id: "bookmark", label: "Add to bookmarks", icon: <Star size={ICON} />, onSelect: () => void bookmarkLocation(child, entry.name) },
  );

  if (alias) {
    items.push({
      id: "host-fav",
      label: "Add to host favorites",
      icon: <Heart size={ICON} />,
      onSelect: () => void addHostFavorite(alias, entry.name, String(child.path)),
    });
  }

  items.push(
    { id: "copy-path", label: "Copy path", icon: <ClipboardCopy size={ICON} />, onSelect: () => void copyText(String(child.path)) },
    { id: "copy-name", label: "Copy name", onSelect: () => void copyText(entry.name) },
    sep(),
    { id: "delete", label: "Delete", icon: <Trash2 size={ICON} />, shortcut: "Del", danger: true, onSelect: () => void triggerDelete("trash", open, showToast) },
    { id: "delete-perm", label: "Delete permanently", icon: <Trash size={ICON} />, shortcut: "Shift+Del", danger: true, onSelect: () => void triggerDelete("permanent", open, showToast) },
  );

  return items;
}

export interface EmptyMenuDeps {
  paneId: PaneId;
  location: Location;
  onRefresh: (id: PaneId) => void;
}

const SORTS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "size", label: "Size" },
  { key: "mtime", label: "Modified" },
  { key: "kind", label: "Kind" },
  { key: "ext", label: "Extension" },
];
const VIEWS: { mode: ViewMode; label: string }[] = [
  { mode: "details", label: "Details" },
  { mode: "grid", label: "Grid" },
  { mode: "tiles", label: "Tiles" },
];

export function buildEmptyMenu(deps: EmptyMenuDeps): MenuEntry[] {
  const { paneId, location, onRefresh } = deps;
  const open = useUIDialogs.getState().open;
  const p = usePanes.getState();
  const alias = sshAlias(location);

  const items: MenuEntry[] = [
    { id: "mkdir", label: "New folder", icon: <FolderPlus size={ICON} />, shortcut: "F7", onSelect: () => triggerMkdir(open) },
    { id: "refresh", label: "Refresh", icon: <RotateCw size={ICON} />, shortcut: "Ctrl+R", onSelect: () => onRefresh(paneId) },
    sep(),
    {
      id: "view",
      label: "View as",
      icon: <LayoutGrid size={ICON} />,
      children: VIEWS.map((v) => ({
        id: `view-${v.mode}`,
        label: v.label,
        onSelect: () => p.setViewMode(paneId, v.mode),
      })),
    },
    {
      id: "sort",
      label: "Sort by",
      icon: <ArrowDownUp size={ICON} />,
      children: SORTS.map((s) => ({
        id: `sort-${s.key}`,
        label: s.label,
        onSelect: () => p.toggleSortKey(paneId, s.key),
      })),
    },
    { id: "hidden", label: "Toggle hidden files", icon: <Eye size={ICON} />, shortcut: "Ctrl+H", onSelect: () => p.toggleShowHidden(paneId) },
    sep(),
    { id: "bookmark", label: "Add this folder to bookmarks", icon: <Star size={ICON} />, onSelect: () => void bookmarkLocation(location, folderName(location)) },
  ];

  if (alias) {
    items.push({
      id: "host-fav",
      label: "Add this folder to host favorites",
      icon: <Heart size={ICON} />,
      onSelect: () => void addHostFavorite(alias, folderName(location), String(location.path)),
    });
  }

  return items;
}

/** location 경로의 basename (북마크 기본 이름). */
export function folderName(location: Location): string {
  return String(location.path).split("/").filter(Boolean).pop() ?? "/";
}
