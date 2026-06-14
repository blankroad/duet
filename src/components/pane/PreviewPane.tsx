import { useEffect, useState, lazy, Suspense } from "react";
import { X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Entry, Location, PreviewData } from "@/types/bindings";
import { usePanes, activeTab, selectDisplayedEntries } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { formatSize } from "@/lib/format";
import { formatErr } from "@/lib/error";
import { previewStreamUrl } from "@/lib/previewUrl";

// 구문 강조(highlight.js)/마크다운 스택은 무거워 lazy-load — 시작 번들에서 분리.
const PreviewContent = lazy(() =>
  import("@/components/pane/PreviewContent").then((m) => ({ default: m.PreviewContent })),
);
// pdf.js 스택도 무거워 lazy-load.
const PreviewPdf = lazy(() =>
  import("@/components/pane/PreviewPdf").then((m) => ({ default: m.PreviewPdf })),
);

/** 활성 패널 cursor entry 의 파일 Location 만들기 (디렉토리/없음이면 null). */
function cursorFileLocation(): { location: Location; entry: Entry } | null {
  const s = usePanes.getState();
  const tab = activeTab(s, s.activePane);
  const displayed = selectDisplayedEntries(s.activePane, s);
  const entry = displayed[tab.cursorIndex];
  if (!entry || entry.kind !== "file") return null;
  const base = tab.location.path;
  const sep = base.endsWith("/") ? "" : "/";
  return { location: { source: tab.location.source, path: base + sep + entry.name }, entry };
}

type LoadState =
  | { phase: "empty" }
  | { phase: "loading"; name: string }
  | { phase: "error"; name: string; message: string }
  | { phase: "ready"; name: string; location: Location; data: PreviewData };

/**
 * 미리보기 패널 — 듀얼 패널 우측 접이식 컬럼 (F11 토글).
 * 활성 패널 cursor 가 파일이면 fsReadPreview 호출 (debounce) → 텍스트/이미지 렌더.
 * 파일 읽기는 백엔드 커맨드 경유 (CLAUDE.md §1).
 */
export function PreviewPane() {
  const togglePreview = useUI((s) => s.togglePreview);
  // 활성 패널 + cursor + location 변화에 반응하기 위해 store 를 구독.
  const dep = usePanes((s) => {
    const tab = activeTab(s, s.activePane);
    const displayed = selectDisplayedEntries(s.activePane, s);
    const entry = displayed[tab.cursorIndex];
    const srcKey =
      tab.location.source.kind === "ssh" ? tab.location.source.connection_id.toString() : "local";
    return `${s.activePane}|${srcKey}|${tab.location.path}|${entry?.name ?? ""}|${entry?.kind ?? ""}`;
  });

  const [state, setState] = useState<LoadState>({ phase: "empty" });

  useEffect(() => {
    const target = cursorFileLocation();
    if (!target) {
      setState({ phase: "empty" });
      return;
    }
    const name = target.entry.name;
    let cancelled = false;
    setState({ phase: "loading", name });
    const t = setTimeout(async () => {
      const r = await commands.fsReadPreview(target.location);
      if (cancelled) return;
      if (r.status === "ok")
        setState({ phase: "ready", name, location: target.location, data: r.data });
      else setState({ phase: "error", name, message: formatErr(r.error) });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [dep]);

  return (
    <div className="flex w-80 shrink-0 flex-col overflow-hidden rounded-panel border border-border">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="truncate text-meta text-fg-muted">
          {state.phase === "empty" ? "Preview" : state.name}
        </span>
        <button
          type="button"
          title="Close preview (F11)"
          aria-label="Close preview"
          onClick={() => togglePreview()}
          className="flex h-5 w-5 items-center justify-center rounded-panel text-fg-muted hover:bg-subtle hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <PreviewBody state={state} />
      </div>
    </div>
  );
}

function PreviewBody({ state }: { state: LoadState }) {
  if (state.phase === "empty") {
    return <Centered>Select a file to preview</Centered>;
  }
  if (state.phase === "loading") {
    return <Centered>Loading…</Centered>;
  }
  if (state.phase === "error") {
    return <Centered tone="danger">{state.message}</Centered>;
  }
  const { data } = state;
  switch (data.kind) {
    case "text":
      return (
        <Suspense fallback={<Centered>Loading…</Centered>}>
          <PreviewContent name={state.name} text={data.text ?? ""} truncated={data.truncated} />
        </Suspense>
      );
    case "image":
      return (
        <div className="flex items-center justify-center p-2">
          <img
            src={`data:${data.mime};base64,${data.bytes_base64}`}
            alt={state.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    case "pdf":
      return (
        <Suspense fallback={<Centered>Loading…</Centered>}>
          <PreviewPdf
            url={previewStreamUrl(state.location)}
            onFallback={() => void commands.openPath(state.location)}
          />
        </Suspense>
      );
    case "audio":
    case "video":
      // location 변경 시 remount 로 error 상태 리셋.
      return <MediaPreview key={state.location.path} kind={data.kind} location={state.location} />;
    case "binary":
      return (
        <Centered>
          Binary file · {formatSize(data.total_size)}
        </Centered>
      );
    case "toolarge":
      return (
        <Centered>
          Too large to preview · {formatSize(data.total_size)}
        </Centered>
      );
  }
}

/** 오디오/비디오 미리보기 — 코덱 미지원(특히 Linux/WebKitGTK) 시 외부 앱 폴백. */
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

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "danger";
}) {
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
