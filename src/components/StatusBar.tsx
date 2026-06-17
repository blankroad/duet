import { usePanes, activeTab } from "@/stores/panes";
import { formatSize } from "@/lib/format";

/**
 * StatusBar — 활성 패널의 항목 통계 + 소스 라벨.
 *
 * DESIGN.md 매핑:
 * "12 items • 3 selected (4.2 MB)    user@host"
 *
 * (드래그-아웃은 이제 파일 행을 직접 끌면 됨 — useEntryDrag 가 로컬 항목을 OS
 * 네이티브 드래그로 시작. 하단 전용 버튼은 중복이라 제거.)
 */
export function StatusBar() {
  const activeId = usePanes((s) => s.activePane);
  const tab = usePanes((s) => activeTab(s, activeId));

  const src = tab.location.source;
  const sourceLabel =
    src.kind === "local" ? "Local" : `${src.user}@${src.host_ip}`;

  const totalCount = tab.entries.length;
  const selectedCount = tab.selected.size;
  const selectedSize = tab.entries
    .filter(
      (e: { name: string; size?: number | null }) =>
        tab.selected.has(e.name) && e.size != null,
    )
    .reduce(
      (sum: number, e: { size?: number | null }) => sum + (e.size ?? 0),
      0,
    );

  return (
    <footer className="flex h-6 items-center justify-between border-t border-border px-3 text-meta text-fg-muted">
      <span>
        {totalCount} items
        {selectedCount > 0 &&
          ` • ${selectedCount} selected (${formatSize(selectedSize)})`}
      </span>
      <span>{sourceLabel}</span>
    </footer>
  );
}
