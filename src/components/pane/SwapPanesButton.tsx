import { ArrowLeftRight } from "lucide-react";
import { usePanes } from "@/stores/panes";

/**
 * 두 패널 사이 좌↔우 내용 교환 버튼.
 * 키보드 Ctrl+U (command pane.swap) 와 동일 동작 — 마우스 사용자 발견성용.
 */
export function SwapPanesButton() {
  const swapPanes = usePanes((s) => s.swapPanes);
  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={swapPanes}
        title="Swap panels (left ↔ right) — Ctrl+U"
        aria-label="Swap panels (left ↔ right)"
        className="rounded-panel p-1 text-fg-muted transition-colors hover:bg-subtle hover:text-fg"
      >
        <ArrowLeftRight size={14} />
      </button>
    </div>
  );
}
