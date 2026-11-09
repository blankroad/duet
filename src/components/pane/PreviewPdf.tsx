import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import * as pdfjsLib from "pdfjs-dist";
import { preparePdfSource } from "./pdfRange";
// Vite ?url — 번들된 워커 에셋 경로. CSP worker-src 'self' blob: 로 허용.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/** 미리보기 패널에 렌더할 최대 페이지 수 (큰 PDF 보호). */
const MAX_PAGES = 20;

/**
 * PDF 미리보기 — pdf.js 로 `duet-preview://` 스트림을 canvas 렌더.
 * 무거운 스택이라 호출부에서 lazy-load. 실패 시 fallback(외부 앱 열기 버튼).
 *
 * 문서를 받는 동안(원격은 특히 오래 걸림) "불러오는 중"을 보이고, 앞 20페이지만 그렸으면
 * 전체 페이지 수와 함께 알려 준다 — 예전엔 빈 화면이 이어지고 뒤 페이지가 없다는 걸 몰랐다.
 */
export function PreviewPdf({
  url,
  fallback,
}: {
  url: string;
  fallback: ReactNode;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [pages, setPages] = useState<{ shown: number; total: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    const fail = () => {
      if (!cancelled) setFailed(true);
      controller.abort();
      void loadingTask?.destroy();
    };
    setPages(null);
    setFailed(false);
    void (async () => {
      const container = containerRef.current;
      if (!container) return;
      container.replaceChildren();
      try {
        const source = await preparePdfSource(
          url,
          controller.signal,
          pdfjsLib.PDFDataRangeTransport,
          fail,
        );
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument(source);
        const doc = await loadingTask.promise;
        if (cancelled) return;
        const pages = Math.min(doc.numPages, MAX_PAGES);
        const total = doc.numPages;
        // 첫 페이지가 그려질 때까지 "불러오는 중"을 유지한다 — 문서 정보만 받고 첫 페이지를
        // 기다리는 동안(원격) 빈 화면이 이어지지 않게. 그 뒤에 절단 안내를 보인다.
        let shownInfo = false;
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
          if (cancelled) return;
          if (!shownInfo) {
            shownInfo = true;
            setPages({ shown: pages, total });
          }
        }
        if (!shownInfo) setPages({ shown: pages, total });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
      void loadingTask?.destroy();
    };
  }, [url]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-meta text-fg-muted">
        <span>{t("preview.pdfFailed")}</span>
        {fallback}
      </div>
    );
  }
  return (
    <div>
      {pages === null && (
        <div className="p-4 text-center text-meta text-fg-muted">
          <span className="animate-fade-in-late">{t("preview.loading")}</span>
        </div>
      )}
      <div ref={containerRef} className="p-1" />
      {pages !== null && pages.total > pages.shown && (
        <div className="flex flex-col items-center gap-2 border-t border-border px-2 py-2 text-center text-meta text-fg-muted">
          <span>
            {t("preview.pdfTruncated", {
              shown: pages.shown,
              total: pages.total,
            })}
          </span>
          {fallback}
        </div>
      )}
    </div>
  );
}
