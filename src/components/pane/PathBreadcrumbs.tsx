import { MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useContextMenu } from "@/stores/contextMenu";

/** 현재 폴더에 폭을 우선 배정하고 상위 경로는 기존 탐색 메뉴로 제공한다. */
export function PathBreadcrumbs({
  items,
  onNavigate,
  showPaths = true,
}: {
  showPaths?: boolean;
  items: { label: string; path: string }[];
  onNavigate: ((path: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const current = items[items.length - 1];
  if (!current) return null;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 font-mono">
      {items.length > 1 && (
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-border"
          aria-label={t("pathbar.parentFolders")}
          title={t("pathbar.parentFolders")}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            useContextMenu.getState().openAt(
              rect.left,
              rect.bottom + 4,
              items.slice(0, -1).map((item, i) => ({
                id: String(i),
                label: item.label,
                shortcut: showPaths ? item.path : item.label,
                onSelect: () => onNavigate?.(item.path),
              })),
            );
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      <button
        type="button"
        className="min-w-0 truncate rounded px-1 py-1 text-fg hover:bg-border"
        title={showPaths ? current.path : current.label}
        onClick={() => onNavigate?.(current.path)}
      >
        {current.label}
      </button>
    </div>
  );
}
