import { Settings as SettingsIcon } from "lucide-react";
import { usePanes } from "@/stores/panes";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { formatSize } from "@/lib/format";

/**
 * StatusBar — 활성 패널의 항목 통계 + Settings 아이콘.
 *
 * DESIGN.md 매핑:
 * "12 items • 3 selected (4.2 MB)         user@host  ●"
 *
 * 우측 끝 gear 아이콘 → SettingsDialog 열기.
 */
export function StatusBar() {
  const activeId = usePanes((s) => s.activePane);
  const pane = usePanes((s) => s.panes[activeId]);
  const openDialog = useUIDialogs((s) => s.open);

  const sourceLabel =
    pane.location.source.kind === "local"
      ? "Local"
      : `${pane.location.source.user}@${pane.location.source.host_ip}`;

  const totalCount = pane.entries.length;
  const selectedCount = pane.selected.size;
  const selectedSize = pane.entries
    .filter((e) => pane.selected.has(e.name) && e.size != null)
    .reduce((sum, e) => sum + (e.size ?? 0), 0);

  return (
    <footer className="flex h-6 items-center justify-between border-t border-border px-3 text-meta text-fg-muted">
      <span>
        {totalCount} items
        {selectedCount > 0 && ` • ${selectedCount} selected (${formatSize(selectedSize)})`}
      </span>
      <div className="flex items-center gap-2">
        <span>{sourceLabel}</span>
        <button
          type="button"
          onClick={() => openDialog({ kind: "settings" })}
          className="rounded p-0.5 hover:bg-border"
          aria-label="Settings"
          title="Settings"
        >
          <SettingsIcon size={12} />
        </button>
      </div>
    </footer>
  );
}
