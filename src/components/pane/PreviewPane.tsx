import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Entry, Location, PreviewData } from "@/types/bindings";
import { usePanes, activeTab, selectDisplayedEntries } from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { usePreviewHover } from "@/stores/previewHover";
import { formatErr } from "@/lib/error";
import { PreviewView, Centered } from "@/components/pane/PreviewView";
import { PreviewInspector } from "@/components/pane/PreviewInspector";

export type PreviewTarget = { entry: Entry; location: Location };

/** 활성 패널 cursor 항목(종류 무관, ".." 제외) + 그 Location. 없으면 null. */
export function cursorTarget(): PreviewTarget | null {
  const s = usePanes.getState();
  const tab = activeTab(s, s.activePane);
  const displayed = selectDisplayedEntries(s.activePane, s);
  const entry = displayed[tab.cursorIndex];
  if (!entry || entry.name === "..") return null;
  const base = tab.location.path;
  const sep = base.endsWith("/") ? "" : "/";
  return { location: { source: tab.location.source, path: base + sep + entry.name }, entry };
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

function locKey(loc: Location | null): string {
  if (!loc) return "";
  const src = loc.source.kind === "ssh" ? loc.source.connection_id.toString() : "local";
  return `${src}|${loc.path}`;
}

/** target(파일)의 미리보기 fetch (debounce). 파일이 아니거나 null 이면 empty. */
export function usePreviewLoad(target: PreviewTarget | null): LoadState {
  const fileLoc = target && target.entry.kind === "file" ? target.location : null;
  const name = target?.entry.name ?? "";
  const key = locKey(fileLoc);
  const locRef = useRef(fileLoc);
  locRef.current = fileLoc;
  const nameRef = useRef(name);
  nameRef.current = name;
  const [state, setState] = useState<LoadState>({ phase: "empty" });

  useEffect(() => {
    const loc = locRef.current;
    const nm = nameRef.current;
    if (!loc) {
      setState({ phase: "empty" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading", name: nm });
    const t = setTimeout(async () => {
      const r = await commands.fsReadPreview(loc);
      if (cancelled) return;
      if (r.status === "ok") setState({ phase: "ready", name: nm, location: loc, data: r.data });
      else setState({ phase: "error", name: nm, message: formatErr(r.error) });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);

  return state;
}

function PreviewBody({ state }: { state: LoadState }) {
  if (state.phase === "empty") return <Centered>Select a file to preview</Centered>;
  if (state.phase === "loading") return <Centered>Loading…</Centered>;
  if (state.phase === "error") return <Centered tone="danger">{state.message}</Centered>;
  return <PreviewView name={state.name} location={state.location} data={state.data} />;
}

/**
 * 미리보기 + 인스펙터 패널 — 듀얼 패널 우측 컬럼 (F11 토글, 기본 ON).
 * 대상 = 호버한 항목(있으면) 아니면 활성 패널 cursor. 파일이면 미리보기 렌더,
 * 폴더면 속성만. 파일 읽기는 백엔드 커맨드 경유 (CLAUDE.md §1).
 */
export function PreviewPane() {
  const togglePreview = useUI((s) => s.togglePreview);
  const hover = usePreviewHover((s) => s.target);
  const cursorKey = usePanes(cursorPreviewDep);
  // 호버 우선, 없으면 cursor. cursorKey 는 cursorTarget()(비반응 getState)의
  // 재평가 트리거라 의도적 의존성.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => hover ?? cursorTarget(), [hover, cursorKey]);
  const state = usePreviewLoad(target);

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
export { PreviewBody };
export type { LoadState };
