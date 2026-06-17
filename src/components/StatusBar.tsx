import { useEffect, useRef } from "react";
import { Upload } from "lucide-react";
import { usePanes, activeTab } from "@/stores/panes";
import { formatSize } from "@/lib/format";
import {
  resolveDragPaths,
  startDragWithPaths,
  startDragOut,
} from "@/lib/dragOut";
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

  // 미리 해석해 둔 절대경로 — mousedown 에서 await 없이 동기 발사하기 위함.
  // (드래그 직전 IPC await 가 들어가면 제스처가 끊겨 OS 드래그가 안 붙는다.)
  const dragPathsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!isLocal || selectedCount === 0) {
      dragPathsRef.current = [];
      return;
    }
    let cancelled = false;
    const targets: EntryRef[] = Array.from(tab.selected).map((name) => ({
      location: tab.location,
      name,
    }));
    void resolveDragPaths(targets).then((paths) => {
      if (!cancelled) dragPathsRef.current = paths;
    });
    return () => {
      cancelled = true;
    };
  }, [isLocal, selectedCount, tab.selected, tab.location]);

  // 드래그-아웃 대상: 활성 패널의 선택(로컬 전용). mousedown 에 OS 드래그 시작.
  const onDragOut = (e: React.MouseEvent) => {
    e.preventDefault();
    // 캐시된 경로가 있으면 동기 발사(제스처 유지). 없으면(선택 직후 즉시 클릭) 폴백.
    const cached = dragPathsRef.current;
    if (cached.length > 0) {
      startDragWithPaths(cached);
      return;
    }
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
        {selectedCount > 0 &&
          ` • ${selectedCount} selected (${formatSize(selectedSize)})`}
      </span>
      {isLocal && selectedCount > 0 && (
        <button
          type="button"
          onMouseDown={onDragOut}
          className="flex cursor-grab items-center gap-1 rounded px-1.5 hover:bg-subtle hover:text-fg active:cursor-grabbing"
          title="Drag out to Finder / other apps (copy)"
        >
          <Upload size={11} />
          <span>drag out ({selectedCount})</span>
        </button>
      )}
      <span>{sourceLabel}</span>
    </footer>
  );
}
