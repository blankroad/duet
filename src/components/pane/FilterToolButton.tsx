import { ListFilter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useKeyHint } from "@/lib/keyHint";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { ToolButton } from "./ToolButton";

/**
 * 빠른 필터를 여는 툴바 버튼 — Ctrl+F·`/` 의 마우스 진입점.
 * 필터가 걸려 있으면 눌린 상태로 보이고 툴팁에 현재 필터를 보여 준다.
 */
export function FilterToolButton({ id }: { id: PaneId }) {
  const { t } = useTranslation();
  const filter = usePanes((s) => activeTab(s, id).filter);
  const key = useKeyHint("filter.focus");
  const active = filter.length > 0;
  return (
    <ToolButton
      label={
        active
          ? t("toolbar.filterActive", { text: filter, key })
          : t("toolbar.filter", { key })
      }
      ariaLabel={t("toolbar.filterName")}
      active={active}
      onClick={() => {
        const s = usePanes.getState();
        s.setActivePane(id);
        s.setFilterFocused(id, true);
      }}
    >
      <ListFilter size={15} />
    </ToolButton>
  );
}
