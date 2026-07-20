import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  isParentEntry,
} from "@/stores/panes";
import type { Entry } from "@/types/bindings";
import { formatSize } from "@/lib/format";
import { useHostLabel } from "@/lib/hostLabel";
import {
  kindLabel,
  formatPerms,
  formatFullDate,
  summarizeEntries,
  countLabel,
} from "@/lib/fileInfo";

/**
 * StatusBar — 3 구역: 왼쪽=파일/폴더 집계 + 선택, 가운데=커서 항목 상세, 오른쪽=소스.
 *
 * "12 files, 3 folders · 1.1 GB    report.pdf — PDF document · 4.2 MB · …    user@host"
 *
 * (드래그-아웃은 파일 행을 직접 끌면 됨 — useEntryDrag. 하단 전용 버튼은 제거됨.)
 */
export function StatusBar() {
  const { t } = useTranslation();
  const activeId = usePanes((s) => s.activePane);
  const tab = usePanes((s) => activeTab(s, activeId));

  const src = tab.location.source;
  const sourceLabel = useHostLabel(src);

  // 왼쪽: 파일/폴더 수 + 총 용량(파일만) + 선택. 커서 이동마다 재계산 안 하게 메모이즈
  // (집계는 entries, 선택 용량은 entries+selected 에만 의존).
  const { files, folders, totalSize } = useMemo(
    () => summarizeEntries(tab.entries),
    [tab.entries],
  );
  const counts = countLabel(files, folders);
  const selectedCount = tab.selected.size;
  const selectedSize = useMemo(
    () =>
      tab.entries
        .filter((e: Entry) => tab.selected.has(e.name) && e.size != null)
        .reduce((sum: number, e: Entry) => sum + (e.size ?? 0), 0),
    [tab.entries, tab.selected],
  );

  // 가운데: 커서가 올라간 단일 항목(".." 제외)의 상세.
  const displayed = useMemo(() => computeDisplayed(tab), [tab]);
  const focused = tab.cursorIndex >= 0 ? displayed[tab.cursorIndex] : undefined;
  const focusedMeta =
    focused && !isParentEntry(focused)
      ? [
          kindLabel(focused),
          focused.size != null ? formatSize(focused.size) : null,
          focused.modified_ms != null
            ? formatFullDate(focused.modified_ms)
            : null,
          focused.permissions != null ? formatPerms(focused.permissions) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return (
    <footer className="flex h-6 items-center gap-3 border-t border-border px-3 text-meta text-fg-muted">
      <span className="shrink-0">
        {counts}
        {totalSize > 0 && ` · ${formatSize(totalSize)}`}
        {selectedCount > 0 &&
          ` • ${t("statusbar.selected", { count: selectedCount })} (${formatSize(selectedSize)})`}
      </span>
      <span className="min-w-0 flex-1 truncate text-center">
        {focused && focusedMeta && (
          <>
            <span className="font-mono text-fg" title={focused.name}>
              {focused.name}
            </span>
            {" — "}
            {focusedMeta}
          </>
        )}
      </span>
      <span className="shrink-0">{sourceLabel}</span>
    </footer>
  );
}
