import { Pin, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import type { TabState } from "@/stores/panes";
import { useSourceStatus } from "@/lib/hostLabel";
import { isBroken, SourceIcon, sourceTooltip } from "./SourceIndicator";
import { tabTitle } from "./tabMenu";

interface TabItemProps {
  tab: TabState;
  index: number;
  active: boolean;
  /** 드래그 재정렬 그룹 (패널별) — useReorderable 이 이 속성으로 대상을 찾는다. */
  reorderGroup: string;
  dragging: boolean;
  onSelect: () => void;
  onClose: () => void;
  onTogglePin: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.MouseEvent) => void;
}

/**
 * 탭 하나.
 *
 * - 원격 탭은 라벨 앞에 소스 아이콘(연결 상태 모양) + 호스트 이름. 로컬은 조용히.
 * - 핀 탭은 X 대신 핀 버튼(누르면 고정 해제), 라벨을 짧게 줄인다. 가운데 클릭·
 *   Ctrl+W 로는 닫히지 않는다(가드는 store `closeTab`).
 * - 툴팁 = 호스트 · 주소 · 상태 + 전체 경로 (+ 고정됨).
 */
export function TabItem({
  tab,
  index,
  active,
  reorderGroup,
  dragging,
  onSelect,
  onClose,
  onTogglePin,
  onContextMenu,
  onDragStart,
}: TabItemProps) {
  const { t } = useTranslation();
  const status = useSourceStatus(tab.location.source);
  const label = tabTitle(tab);
  const broken = status.remote && isBroken(status);
  const tooltip = [
    status.remote ? sourceTooltip(status) : null,
    String(tab.location.path),
    tab.pinned ? t("tabs.pinnedTab") : null,
  ]
    .filter((x): x is string => !!x)
    .join("\n");

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={
        status.remote
          ? `${status.label} — ${label} (${status.stateText})`
          : label
      }
      data-tab-index={index}
      data-reorder-key={tab.id}
      data-reorder-group={reorderGroup}
      data-pinned={tab.pinned || undefined}
      onMouseDown={onDragStart}
      onClick={onSelect}
      // 가운데 클릭으로 닫기 — auxclick 이 마우스 가운데 버튼의 표준 경로.
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      onContextMenu={onContextMenu}
      title={tooltip}
      className={clsx(
        "group flex min-w-0 shrink-0 cursor-default items-center gap-1 border-l-2 pl-2 pr-0.5 hover:bg-border",
        tab.pinned ? "max-w-[10rem]" : "max-w-[min(14rem,100%)]",
        active
          ? "border-l-accent bg-base text-fg"
          : "border-l-transparent text-fg-muted",
        dragging && "opacity-50",
      )}
    >
      {status.remote && (
        <span className="flex min-w-0 shrink items-center gap-1">
          <SourceIcon status={status} size={11} />
          <span
            className={clsx(
              "max-w-[7rem] truncate font-medium",
              broken ? "text-fg" : "text-accent",
            )}
          >
            {status.label}
          </span>
        </span>
      )}
      <span className={clsx("truncate", tab.pinned && "max-w-[6rem]")}>
        {label}
      </span>
      {tab.pinned ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label={t("tabs.unpin")}
          title={t("tabs.unpin")}
        >
          <Pin size={11} className="fill-current" />
        </button>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={clsx(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
            active
              ? "opacity-100"
              : "opacity-0 focus:opacity-100 group-hover:opacity-100",
          )}
          aria-label={t("tabs.closeTab")}
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}
