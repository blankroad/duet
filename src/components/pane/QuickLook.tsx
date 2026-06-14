import { useEffect } from "react";
import { X } from "lucide-react";
import { usePanes } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { cursorPreviewDep, usePreviewLoad, PreviewBody } from "@/components/pane/PreviewPane";

/**
 * Quick Look 대형 오버레이 (Space) — 활성 패널 cursor 파일을 크게 미리보기.
 * 열려 있을 때만 마운트(App). 화살표(useKeyboardNav)로 cursor 이동 시 dep 변경 →
 * 미리보기 live-swap (Finder 관례). Esc / 바깥 클릭 / Space 로 닫기.
 *
 * 포커스 트랩을 피하려 Radix Dialog 대신 커스텀 오버레이 — 화살표/Space 가
 * window keydown(useKeyboardNav)에 그대로 도달.
 */
export function QuickLook() {
  const close = useUI((s) => s.closeQuickLook);
  const dep = usePanes(cursorPreviewDep);
  const state = usePreviewLoad(dep);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const title = state.phase === "empty" ? "Quick Look" : state.name;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/70 p-6"
      onMouseDown={close}
      role="presentation"
    >
      <div
        className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-md border border-border bg-base shadow-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
          <span className="truncate text-meta text-fg-muted">{title}</span>
          <button
            type="button"
            onClick={close}
            aria-label="Close Quick Look (Esc)"
            title="Close (Esc / Space)"
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-subtle hover:text-fg"
          >
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <PreviewBody state={state} />
        </div>
      </div>
    </div>
  );
}
