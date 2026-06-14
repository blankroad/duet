import { usePanes, activeTab } from "@/stores/panes";
import { formatSize } from "@/lib/format";

/**
 * StatusBar — 활성 패널의 항목 통계 + 소스 라벨.
 *
 * DESIGN.md 매핑:
 * "12 items • 3 selected (4.2 MB)         user@host"
 * (Settings 는 상단 TopBar 로 이동.)
 */
export function StatusBar() {
  const activeId = usePanes((s) => s.activePane);
  const tab = usePanes((s) => activeTab(s, activeId));

  const sourceLabel =
    tab.location.source.kind === "local"
      ? "Local"
      : `${tab.location.source.user}@${tab.location.source.host_ip}`;

  const totalCount = tab.entries.length;
  const selectedCount = tab.selected.size;
  const selectedSize = tab.entries
    .filter((e: { name: string; size?: number | null }) => tab.selected.has(e.name) && e.size != null)
    .reduce((sum: number, e: { size?: number | null }) => sum + (e.size ?? 0), 0);

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
