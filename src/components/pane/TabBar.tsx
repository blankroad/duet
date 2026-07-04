import { X, Plus } from "lucide-react";
import { usePanes, type PaneId } from "@/stores/panes";
import { basename } from "@/lib/paths";
import clsx from "clsx";

/**
 * 패널 상단 탭 바. 탭 1개일 때는 렌더 X.
 */
export function TabBar({ id }: { id: PaneId }) {
  const tabs = usePanes((s) => s.panes[id].tabs);
  const activeIndex = usePanes((s) => s.panes[id].activeTabIndex);
  const openTab = usePanes((s) => s.openTab);
  const closeTab = usePanes((s) => s.closeTab);
  const selectTab = usePanes((s) => s.selectTab);

  if (tabs.length <= 1) return null;

  return (
    <div className="flex h-7 shrink-0 items-stretch border-b border-border bg-subtle text-meta">
      {tabs.map((t, i) => {
        const active = i === activeIndex;
        const label = labelOf(t.location.path);
        return (
          <div
            key={t.id}
            onClick={() => selectTab(id, i)}
            title={t.location.path}
            className={clsx(
              "group flex cursor-default items-center gap-1 border-l-2 px-2 hover:bg-border",
              active
                ? "border-l-accent bg-base text-fg"
                : "border-l-transparent text-fg-muted",
            )}
          >
            <span className="truncate max-w-[10rem]">{label}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id, i);
              }}
              className={clsx(
                "rounded p-0.5 opacity-0 hover:bg-border group-hover:opacity-100",
                tabs.length <= 1 && "pointer-events-none opacity-30",
              )}
              aria-label="Close tab"
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => openTab(id)}
        className="flex items-center px-2 text-fg-muted hover:bg-border hover:text-fg"
        aria-label="New tab"
        title="New tab"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

function labelOf(path: string): string {
  return basename(path, "/");
}
