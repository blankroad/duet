import { ArrowLeftRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useKeyHint } from "@/lib/keyHint";
import { usePanes } from "@/stores/panes";

/**
 * 두 패널 사이 좌↔우 내용 교환 버튼.
 * 키보드 Ctrl+U (command pane.swap) 와 동일 동작 — 마우스 사용자 발견성용.
 */
export function SwapPanesButton() {
  const { t } = useTranslation();
  const swapPanes = usePanes((s) => s.swapPanes);
  const kSwap = useKeyHint("pane.swap");
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={swapPanes}
        title={t("pathbar.swapPanesTitle", { key: kSwap })}
        aria-label={t("pathbar.swapPanes")}
        className="flex h-6 w-6 items-center justify-center rounded-panel text-fg-muted transition-colors hover:bg-subtle hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <ArrowLeftRight size={14} />
      </button>
    </div>
  );
}
