import { Upload } from "lucide-react";
import { usePanes, activeTab } from "@/stores/panes";
import { formatSize } from "@/lib/format";
import { startDragOut } from "@/lib/dragOut";
import type { EntryRef } from "@/types/bindings";

/**
 * StatusBar — 활성 패널의 항목 통계 + 소스 라벨 + (로컬 선택 시) 드래그-아웃 핸들.
 *
 * DESIGN.md 매핑:
 * "12 items • 3 selected (4.2 MB)    ↗ drag out    user@host"
 */
export function StatusBar() {
  const activeId = usePanes((s) => s.activePane);
  const tab = usePanes((s) => activeTab(s, activeId));

  const src = tab.location.source;
  const isLocal = src.kind === "local";
  const sourceLabel = src.kind === "local" ? "Local" : `${src.user}@${src.host_ip}`;

  const totalCount = tab.entries.length;
  const selectedCount = tab.selected.size;
  const selectedSize = tab.entries
    .filter((e: { name: string; size?: number | null }) => tab.selected.has(e.name) && e.size != null)
    .reduce((sum: number, e: { size?: number | null }) => sum + (e.size ?? 0), 0);

  // 드래그-아웃 대상: 활성 패널의 선택(로컬 전용). mousedown 에 OS 드래그 시작.
  const onDragOut = (e: React.MouseEvent) => {
    e.preventDefault();
    const targets: EntryRef[] = Array.from(tab.selected).map((name) => ({
      location: tab.location,
      name,
    }));
    void startDragOut(targets);
  };

  return (
    <footer className="flex h-6 items-center justify-between border-t border-border px-3 text-meta text-fg-muted">
      <span>
        {totalCount} items
        {selectedCount > 0 && ` • ${selectedCount} selected (${formatSize(selectedSize)})`}
      </span>
      {isLocal && selectedCount > 0 && (
        <button
          type="button"
          onMouseDown={onDragOut}
          className="flex cursor-grab items-center gap-1 rounded px-1.5 hover:bg-subtle hover:text-fg active:cursor-grabbing"
          title="끌어서 Finder/외부 앱으로 내보내기 (복사)"
        >
          <Upload size={11} />
          <span>drag out ({selectedCount})</span>
        </button>
      )}
      <span>{sourceLabel}</span>
    </footer>
  );
}
