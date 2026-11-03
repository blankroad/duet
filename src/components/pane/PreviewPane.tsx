import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Entry, Location, PreviewData } from "@/types/bindings";
import {
  usePanes,
  activeTab,
  selectDisplayedEntries,
  type PaneId,
} from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { usePreviewHover, dropHoverTarget } from "@/stores/previewHover";
import { childLocation } from "@/lib/entryDnd";
import { usePreviewWidth } from "@/stores/previewWidth";
import { beginWidthDrag } from "@/stores/panelWidth";
import { formatErr } from "@/lib/error";
import { PreviewView, Centered } from "@/components/pane/PreviewView";
import { PreviewInspector } from "@/components/pane/PreviewInspector";

export type PreviewTarget = {
  entry: Entry;
  location: Location;
  /** 항목이 속한 패널 — 인스펙터가 그 탭의 폴더 크기 캐시를 읽는 데 사용. */
  paneId: PaneId;
};

/** 활성 패널 cursor 항목(종류 무관, ".." 제외) + 그 Location. 없으면 null. */
export function cursorTarget(): PreviewTarget | null {
  const s = usePanes.getState();
  const tab = activeTab(s, s.activePane);
  const displayed = selectDisplayedEntries(s.activePane, s);
  const entry = displayed[tab.cursorIndex];
  if (!entry || entry.name === "..") return null;
  return {
    // 경로 결합은 공용 헬퍼로 — Windows `C:\dir` 에 "/" 를 섞지 않게 (CLAUDE.md §7).
    location: childLocation(tab.location, entry.name),
    entry,
    paneId: s.activePane,
  };
}

type LoadState =
  | { phase: "empty" }
  | { phase: "loading"; name: string }
  | { phase: "error"; name: string; message: string }
  | { phase: "ready"; name: string; location: Location; data: PreviewData };

/** 활성 패널 cursor + location 변화를 추적하는 구독 키. */
export function cursorPreviewDep(
  s: ReturnType<typeof usePanes.getState>,
): string {
  const tab = activeTab(s, s.activePane);
  const displayed = selectDisplayedEntries(s.activePane, s);
  const entry = displayed[tab.cursorIndex];
  const srcKey =
    tab.location.source.kind === "ssh"
      ? tab.location.source.connection_id.toString()
      : "local";
  // size·mtime 포함 — 같은 이름 파일을 고친 뒤 새로고침하면 미리보기·속성도 다시 읽는다.
  return `${s.activePane}|${srcKey}|${tab.location.path}|${entry?.name ?? ""}|${entry?.kind ?? ""}|${entry?.size ?? ""}|${entry?.modified_ms ?? ""}`;
}

function locKey(loc: Location | null): string {
  if (!loc) return "";
  const src =
    loc.source.kind === "ssh" ? loc.source.connection_id.toString() : "local";
  return `${src}|${loc.path}`;
}

/** target(파일)의 미리보기 fetch (debounce). 파일이 아니거나 null 이면 empty. */
export function usePreviewLoad(target: PreviewTarget | null): LoadState {
  const fileLoc =
    target && target.entry.kind === "file" ? target.location : null;
  const name = target?.entry.name ?? "";
  // 같은 경로라도 크기·수정 시각이 바뀌면(외부 편집 후 새로고침) 다시 읽는다.
  const key = fileLoc
    ? `${locKey(fileLoc)}|${target?.entry.size ?? ""}|${target?.entry.modified_ms ?? ""}`
    : "";
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
      // IPC 자체가 reject 해도(채널·직렬화 오류) 로딩에 갇히지 않게 오류로 전환.
      try {
        const r = await commands.fsReadPreview(loc);
        if (cancelled) return;
        if (r.status === "ok")
          setState({ phase: "ready", name: nm, location: loc, data: r.data });
        else
          setState({ phase: "error", name: nm, message: formatErr(r.error) });
      } catch (e) {
        if (!cancelled)
          setState({ phase: "error", name: nm, message: formatErr(e) });
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);

  return state;
}

function PreviewBody({ state }: { state: LoadState }) {
  const { t } = useTranslation();
  if (state.phase === "empty")
    return <Centered>{t("preview.selectFile")}</Centered>;
  if (state.phase === "loading")
    // 늦게 나타나게(200ms) — 빠른 로컬에서 ↑↓ 할 때 "불러오는 중"이 깜빡이지 않도록.
    return (
      <Centered>
        <span className="animate-fade-in-late">{t("preview.loading")}</span>
      </Centered>
    );
  if (state.phase === "error")
    return <Centered tone="danger">{state.message}</Centered>;
  return (
    <PreviewView
      name={state.name}
      location={state.location}
      data={state.data}
    />
  );
}

/**
 * 미리보기 + 인스펙터 패널 — 듀얼 패널 우측 컬럼 (F11 토글, 기본 ON).
 * 대상 = 호버한 항목(있으면) 아니면 활성 패널 cursor. 파일이면 미리보기 렌더,
 * 폴더면 속성만. 파일 읽기는 백엔드 커맨드 경유 (CLAUDE.md §1).
 */
export function PreviewPane({ below = false }: { below?: boolean }) {
  const { t } = useTranslation();
  const togglePreview = useUI((s) => s.togglePreview);
  const hover = usePreviewHover((s) => s.target);
  const cursorKey = usePanes(cursorPreviewDep);
  // 커서가 움직이면(키보드·클릭) 그게 가장 최근 의도 — 남아 있던 호버를 놓아 미리보기가
  // 커서를 따라가게 한다. 마우스를 목록 위에 둔 채 ↑↓ 하면 예전 호버 항목에 멈춰 있었다.
  useEffect(() => {
    dropHoverTarget();
  }, [cursorKey]);
  // 호버 우선, 없으면 cursor. cursorKey 는 cursorTarget()(비반응 getState)의
  // 재평가 트리거라 의도적 의존성.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const target = useMemo(() => hover ?? cursorTarget(), [hover, cursorKey]);
  const state = usePreviewLoad(target);
  const width = usePreviewWidth((s) => s.width);
  const setWidth = usePreviewWidth((s) => s.setWidth);
  const reset = usePreviewWidth((s) => s.reset);

  return (
    <div
      className="relative flex shrink-0 flex-col overflow-hidden rounded-panel border border-border"
      style={{ width: below ? "100%" : width, height: "100%" }}
    >
      {/* 왼쪽 가장자리를 끌어 폭 조절 — 정보 패널은 보조라 기본은 좁게(260px). */}
      {!below && (
        <div
          onPointerDown={(e) =>
            beginWidthDrag(
              e,
              "left",
              usePreviewWidth.getState().width,
              setWidth,
            )
          }
          onDoubleClick={reset}
          title={t("preview.resizeTitle")}
          className="absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/50"
        />
      )}
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border px-2">
        <span className="truncate text-meta text-fg-muted">
          {t("preview.info")}
        </span>
        <button
          type="button"
          title={t("preview.closeTitle")}
          aria-label={t("preview.close")}
          onClick={() => togglePreview()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-panel text-fg-muted hover:bg-subtle hover:text-fg"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!target ? (
          <Centered>{t("preview.selectItem")}</Centered>
        ) : (
          <>
            <PreviewInspector
              entry={target.entry}
              location={target.location}
              paneId={target.paneId}
            />
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
