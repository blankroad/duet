import { usePanes } from "@/stores/panes";
import { formatSize } from "@/lib/format";

/**
 * StatusBar — 활성 패널의 항목 통계.
 *
 * DESIGN.md 매핑:
 * "12 items • 3 selected (4.2 MB)         user@host  ●"
 *
 * MVP-0: 항목 수 + 선택 정보(선택 있을 때만) + 호스트(Local/SSH user@host).
 */
export function StatusBar() {
  const activeId = usePanes((s) => s.activePane);
  const pane = usePanes((s) => s.panes[activeId]);

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
      <span>{sourceLabel}</span>
    </footer>
  );
}
