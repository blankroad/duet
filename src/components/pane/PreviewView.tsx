import { useState, lazy, Suspense } from "react";
import { commands } from "@/types/bindings";
import type { Location, PreviewData } from "@/types/bindings";
import { formatSize } from "@/lib/format";
import { previewStreamUrl } from "@/lib/previewUrl";

// 무거운 스택은 lazy chunk 로 분리.
const PreviewContent = lazy(() =>
  import("@/components/pane/PreviewContent").then((m) => ({ default: m.PreviewContent })),
);
const PreviewPdf = lazy(() =>
  import("@/components/pane/PreviewPdf").then((m) => ({ default: m.PreviewPdf })),
);

/**
 * 미리보기 본문 렌더 — 도킹 패널(PreviewPane)과 Quick Look 오버레이가 공유.
 * kind 별 분기: 텍스트(구문강조/마크다운)·이미지·PDF·오디오·비디오·바이너리.
 */
export function PreviewView({
  name,
  location,
  data,
}: {
  name: string;
  location: Location;
  data: PreviewData;
}) {
  switch (data.kind) {
    case "text":
      return (
        <Suspense fallback={<Centered>Loading…</Centered>}>
          <PreviewContent name={name} text={data.text ?? ""} truncated={data.truncated} />
        </Suspense>
      );
    case "image":
      return (
        <div className="flex h-full items-center justify-center p-2">
          <img
            src={`data:${data.mime};base64,${data.bytes_base64}`}
            alt={name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case "pdf":
      return (
        <Suspense fallback={<Centered>Loading…</Centered>}>
          <PreviewPdf
            url={previewStreamUrl(location)}
            onFallback={() => void commands.openPath(location)}
          />
        </Suspense>
      );
    case "audio":
    case "video":
      // location 변경 시 remount 로 error 상태 리셋.
      return <MediaPreview key={location.path} kind={data.kind} location={location} />;
    case "binary":
      return <NoPreview label={`Binary file · ${formatSize(data.total_size)}`} location={location} />;
    case "toolarge":
      return (
        <NoPreview label={`Too large to preview · ${formatSize(data.total_size)}`} location={location} />
      );
  }
}

/** 미리보기 불가(바이너리/대용량) — 외부 앱 열기 제공. */
function NoPreview({ label, location }: { label: string; location: Location }) {
  return (
    <Centered>
      <div className="flex flex-col items-center gap-2">
        <span>{label}</span>
        <button
          type="button"
          onClick={() => void commands.openPath(location)}
          className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
        >
          Open in default app
        </button>
      </div>
    </Centered>
  );
}

/** 오디오/비디오 — 코덱 미지원(특히 Linux/WebKitGTK) 시 외부 앱 폴백. */
function MediaPreview({ kind, location }: { kind: "audio" | "video"; location: Location }) {
  const [failed, setFailed] = useState(false);
  const url = previewStreamUrl(location);
  if (failed) {
    return (
      <Centered>
        <div className="flex flex-col items-center gap-2">
          <span>Cannot play {kind} here</span>
          <button
            type="button"
            onClick={() => void commands.openPath(location)}
            className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
          >
            Open in default app
          </button>
        </div>
      </Centered>
    );
  }
  if (kind === "audio") {
    return (
      <div className="flex h-full items-center justify-center p-3">
        <audio controls src={url} className="w-full" onError={() => setFailed(true)} />
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center bg-black/80 p-1">
      <video controls src={url} className="max-h-full max-w-full" onError={() => setFailed(true)} />
    </div>
  );
}

export function Centered({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <div
      className={`flex h-full items-center justify-center p-4 text-center text-meta ${
        tone === "danger" ? "text-danger" : "text-fg-muted"
      }`}
    >
      {children}
    </div>
  );
}
