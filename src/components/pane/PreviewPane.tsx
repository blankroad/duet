import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Entry, Location, PreviewData } from "@/types/bindings";
import { usePanes, activeTab, selectDisplayedEntries } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { formatErr } from "@/lib/error";
import { PreviewView, Centered } from "@/components/pane/PreviewView";
import { PreviewInspector } from "@/components/pane/PreviewInspector";

/** 활성 패널 cursor 항목(종류 무관, ".." 제외) + 그 Location. 없으면 null. */
function cursorTarget(): { location: Location; entry: Entry } | null {
  const s = usePanes.getState();
  const tab = activeTab(s, s.activePane);
  const displayed = selectDisplayedEntries(s.activePane, s);
  const entry = displayed[tab.cursorIndex];
  if (!entry || entry.name === "..") return null;
  const base = tab.location.path;
  const sep = base.endsWith("/") ? "" : "/";
  return { location: { source: tab.location.source, path: base + sep + entry.name }, entry };
}

/** 위 중 파일만 (미리보기 fetch 대상). */
function cursorFileLocation(): { location: Location; entry: Entry } | null {
  const t = cursorTarget();
  return t && t.entry.kind === "file" ? t : null;
}

type LoadState =
  | { phase: "empty" }
  | { phase: "loading"; name: string }
  | { phase: "error"; name: string; message: string }
  | { phase: "ready"; name: string; location: Location; data: PreviewData };

/** 활성 패널 cursor + location 변화를 추적하는 구독 키. */
export function cursorPreviewDep(s: ReturnType<typeof usePanes.getState>): string {
  const tab = activeTab(s, s.activePane);
  const displayed = selectDisplayedEntries(s.activePane, s);
  const entry = displayed[tab.cursorIndex];
  const srcKey =
    tab.location.source.kind === "ssh" ? tab.location.source.connection_id.toString() : "local";
  return `${s.activePane}|${srcKey}|${tab.location.path}|${entry?.name ?? ""}|${entry?.kind ?? ""}`;
}

/** cursor 파일 미리보기 fetch (debounce). LoadState 를 setState 로 흘린다. */
function usePreviewLoad(dep: string): LoadState {
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
  return state;
}

function PreviewBody({ state }: { state: LoadState }) {
  if (state.phase === "empty") return <Centered>Select a file to preview</Centered>;
  if (state.phase === "loading") return <Centered>Loading…</Centered>;
  if (state.phase === "error") return <Centered tone="danger">{state.message}</Centered>;
  return <PreviewView name={state.name} location={state.location} data={state.data} />;
}

/**
 * 미리보기 패널 — 듀얼 패널 우측 접이식 컬럼 (F11 토글).
 * 활성 패널 cursor 가 파일이면 fsReadPreview 호출 (debounce) → 텍스트/이미지/PDF/AV 렌더.
 * 파일 읽기는 백엔드 커맨드 경유 (CLAUDE.md §1).
 */
export function PreviewPane() {
  const togglePreview = useUI((s) => s.togglePreview);
  const dep = usePanes(cursorPreviewDep);
  const state = usePreviewLoad(dep);
  const target = cursorTarget();

  return (
    <div className="flex w-80 shrink-0 flex-col overflow-hidden rounded-panel border border-border">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="truncate text-meta text-fg-muted">Info</span>
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
        {!target ? (
          <Centered>Select a file or folder</Centered>
        ) : (
          <>
            <PreviewInspector entry={target.entry} location={target.location} />
            {target.entry.kind === "file" && <PreviewBody state={state} />}
          </>
        )}
      </div>
    </div>
  );
}

/** Quick Look 오버레이가 동일 fetch 로직을 쓰도록 노출. */
export { usePreviewLoad, PreviewBody };
export type { LoadState };
