import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";

const CRUMB_FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";

/**
 * 현재 폴더에 폭을 우선 배정하고 상위 경로는 `…` 메뉴로 제공한다.
 * 상위 메뉴는 가까운 부모부터(바로 위 폴더가 첫 항목) 나열한다.
 */
export function PathBreadcrumbs({
  items,
  onNavigate,
  showPaths = true,
  onCurrentClick,
  currentTitle,
  menuHead,
  onCurrentContextMenu,
}: {
  showPaths?: boolean;
  items: { label: string; path: string }[];
  onNavigate: ((path: string) => void) | undefined;
  /** 현재 폴더 이름 클릭 — 없으면 그 경로로 다시 이동(새로고침). */
  onCurrentClick?: (() => void) | undefined;
  /** 현재 폴더 버튼 툴팁 (기본: 경로). */
  currentTitle?: string | undefined;
  /** `…` 메뉴 맨 위에 붙일 항목 (예: 경로 복사). */
  menuHead?: MenuEntry[] | undefined;
  onCurrentContextMenu?: ((e: React.MouseEvent) => void) | undefined;
}) {
  const { t } = useTranslation();
  const current = items[items.length - 1];
  if (!current) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 font-mono">
      {items.length > 1 && (
        <button
          type="button"
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-fg ${CRUMB_FOCUS}`}
          aria-label={t("pathbar.parentFolders")}
          aria-haspopup="menu"
          title={t("pathbar.parentFolders")}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const parents: MenuEntry[] = items
              .slice(0, -1)
              .map((item, i) => ({
                id: String(i),
                label: item.label,
                shortcut: showPaths ? item.path : item.label,
                onSelect: () => onNavigate?.(item.path),
              }))
              .reverse();
            useContextMenu
              .getState()
              .openAt(rect.left, rect.bottom + 4, [
                ...(menuHead ?? []),
                ...parents,
              ]);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      <button
        type="button"
        className={`min-w-0 truncate rounded px-1 py-1 text-fg hover:bg-border ${CRUMB_FOCUS}`}
        title={currentTitle ?? (showPaths ? current.path : current.label)}
        onClick={() =>
          onCurrentClick ? onCurrentClick() : onNavigate?.(current.path)
        }
        onContextMenu={
          onCurrentContextMenu
            ? (e) => {
                e.preventDefault();
                onCurrentContextMenu(e);
              }
            : undefined
        }
      >
        {current.label}
      </button>
    </div>
  );
}
