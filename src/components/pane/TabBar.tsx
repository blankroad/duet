import { X, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePanes, type PaneId } from "@/stores/panes";
import { useContextMenu, type MenuEntry } from "@/stores/contextMenu";
import { basename } from "@/lib/paths";
import i18n from "@/i18n";
import clsx from "clsx";

/**
 * 패널 상단 탭 바. 탭 1개일 때는 렌더 X (새 탭은 PathBar 의 + 로).
 *
 * 우클릭 = 탭 정리 메뉴, 가운데 클릭 = 그 탭 닫기 (브라우저 관례).
 */
export function TabBar({ id }: { id: PaneId }) {
  const { t: tr } = useTranslation();
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
        // 원격 탭은 호스트를 앞에 — 로컬 /var/log 탭과 원격 /var/log 탭이
        // 이름만으로는 구분되지 않았다.
        const host =
          t.location.source.kind === "ssh"
            ? (t.location.source.connection_id.split(":")[0] ?? "")
            : null;
        return (
          <div
            key={t.id}
            onClick={() => selectTab(id, i)}
            // 가운데 클릭으로 닫기 — auxclick 이 마우스 가운데 버튼의 표준 경로.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                closeTab(id, i);
              }
            }}
            onContextMenu={(e) => openTabMenu(e, id, i)}
            title={t.location.path}
            className={clsx(
              "group flex cursor-default items-center gap-1 border-l-2 px-2 hover:bg-border",
              active
                ? "border-l-accent bg-base text-fg"
                : "border-l-transparent text-fg-muted",
            )}
          >
            <span className="flex max-w-[12rem] items-baseline gap-1 truncate">
              {host && (
                <span className="shrink-0 text-fg-muted/70">{host}:</span>
              )}
              <span className="truncate">{label}</span>
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id, i);
              }}
              className={clsx(
                "rounded p-0.5 opacity-0 hover:bg-border focus:opacity-100 group-hover:opacity-100",
                tabs.length <= 1 && "pointer-events-none opacity-30",
              )}
              aria-label={tr("tabs.closeTab")}
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
        aria-label={tr("tabs.newTab")}
        title={tr("tabs.newTab")}
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

/**
 * 탭 우클릭 메뉴 — 닫기 계열 + 새 탭/복제.
 *
 * "모두 닫기" 는 패널이 탭을 최소 1개 유지해야 하므로 **활성 탭만** 남긴다. 그래서
 * 활성 탭이 아닌 탭에서 눌렀을 때 "다른 탭 모두 닫기"(누른 탭을 남김)와 결과가 다르다.
 */
function openTabMenu(e: React.MouseEvent, id: PaneId, index: number): void {
  e.preventDefault();
  e.stopPropagation();
  const s = usePanes.getState();
  const p = s.panes[id];
  const only = p.tabs.length <= 1;
  const isLast = index >= p.tabs.length - 1;
  const location = p.tabs[index]?.location;
  const items: MenuEntry[] = [
    {
      id: "close",
      label: i18n.t("tabs.closeThis"),
      commandId: "tab.close",
      disabled: only,
      onSelect: () => s.closeTab(id, index),
    },
    {
      id: "close-others",
      label: i18n.t("tabs.closeOthers"),
      disabled: only,
      onSelect: () => s.closeOtherTabs(id, index),
    },
    {
      id: "close-right",
      label: i18n.t("tabs.closeRight"),
      disabled: isLast,
      onSelect: () => s.closeTabsToRight(id, index),
    },
    {
      id: "close-all",
      label: i18n.t("tabs.closeAll"),
      disabled: only,
      onSelect: () => s.closeAllTabs(id),
    },
    { kind: "separator" },
    {
      id: "duplicate",
      label: i18n.t("tabs.duplicate"),
      onSelect: () => location && s.openTab(id, location),
    },
    {
      id: "new-tab",
      label: i18n.t("tabs.newTab"),
      commandId: "tab.new",
      onSelect: () => s.openTab(id),
    },
  ];
  useContextMenu.getState().openAt(e.clientX, e.clientY, items);
}

function labelOf(path: string): string {
  return basename(path, "/");
}
