import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useUI } from "@/stores/ui";
import { useSidebarWidth } from "@/stores/sidebarWidth";
import { usePreviewWidth } from "@/stores/previewWidth";
import { PreviewPane } from "@/components/pane/PreviewPane";

/** 보조 패널의 저장 폭을 유지하면서 탐색 목록에 필요한 공간을 확보한다. */
export function WorkspaceLayout({
  sidebar,
  children,
}: {
  sidebar: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const previewOpen = useUI((s) => s.previewOpen);
  const singlePane = useUI((s) => s.singlePane);
  const preferredSidebar = useSidebarWidth((s) => s.width);
  const previewWidth = usePreviewWidth((s) => s.width);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // 듀얼 패널 사이 교환 버튼과 간격도 예산에 포함한다.
  const listWidth = singlePane ? 280 : 600;
  const sidebarWidth = sidebarOpen
    ? Math.min(preferredSidebar, Math.max(150, width - listWidth - 6))
    : 0;
  const below =
    width - sidebarWidth - (sidebarOpen ? 6 : 0) < listWidth + previewWidth + 6;
  return (
    <main ref={ref} className="flex flex-1 min-h-0 min-w-0 gap-1.5 p-1.5">
      {sidebarOpen && (
        <div className="flex min-h-0 shrink-0" style={{ width: sidebarWidth }}>
          {sidebar}
        </div>
      )}
      <div
        className={`flex min-h-0 min-w-0 flex-1 gap-1.5 ${below ? "flex-col" : ""}`}
      >
        <div className="flex min-h-0 min-w-0 flex-1 gap-1.5">{children}</div>
        {previewOpen && (
          <div
            className={
              below
                ? "min-h-0 basis-[35%] max-h-60 shrink-0"
                : "flex min-h-0 shrink-0"
            }
            data-preview-placement={below ? "below" : "side"}
          >
            <PreviewPane below={below} />
          </div>
        )}
      </div>
    </main>
  );
}
