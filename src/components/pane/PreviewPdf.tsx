import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
// Vite ?url — 번들된 워커 에셋 경로. CSP worker-src 'self' blob: 로 허용.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** 미리보기 패널에 렌더할 최대 페이지 수 (큰 PDF 보호). */
const MAX_PAGES = 20;

/**
 * PDF 미리보기 — pdf.js 로 `duet-preview://` 스트림을 canvas 렌더.
 * 무거운 스택이라 호출부에서 lazy-load. 실패 시 onFallback(외부 앱 열기).
 */
export function PreviewPdf({ url, onFallback }: { url: string; onFallback: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let doc: pdfjsLib.PDFDocumentProxy | null = null;
    void (async () => {
      const container = containerRef.current;
      if (!container) return;
      container.replaceChildren();
      try {
        doc = await pdfjsLib.getDocument({ url }).promise;
        if (cancelled) return;
        const pages = Math.min(doc.numPages, MAX_PAGES);
        for (let i = 1; i <= pages; i += 1) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const unit = page.getViewport({ scale: 1 });
          const scale = Math.max(0.2, (container.clientWidth - 8) / unit.width);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "mb-2 w-full border border-border";
          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          container.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport }).promise;
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [url]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-meta text-fg-muted">
        <span>Cannot render PDF</span>
        <button
          type="button"
          onClick={onFallback}
          className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
        >
          Open in default app
        </button>
      </div>
    );
  }
  return <div ref={containerRef} className="p-1" />;
}
