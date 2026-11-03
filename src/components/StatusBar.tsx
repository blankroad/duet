import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  isParentEntry,
} from "@/stores/panes";
import { useUI } from "@/stores/ui";
import { useConnections } from "@/stores/connections";
import type { Entry } from "@/types/bindings";
import { formatSize } from "@/lib/format";
import { useHostLabel } from "@/lib/hostLabel";
import { useKeyHint } from "@/lib/keyHint";
import {
  keepButtonActivationLocal,
  releaseFocusAfterMouse,
} from "@/lib/keyIsolation";
import { isVirtualTrash, trashItemFor } from "@/lib/trashView";
import {
  kindLabel,
  formatPerms,
  formatFullDate,
  summarizeEntries,
  countLabel,
} from "@/lib/fileInfo";
import { StateDot } from "@/components/Sidebar";

/**
 * StatusBar — 3 구역: 왼쪽=보이는 항목 집계 + 가려진 항목 + 선택, 가운데=커서 항목 상세,
 * 오른쪽=활성 패널(L/R)·소스·연결 상태.
 *
 * "12 files, 3 folders · 1.1 GB · 숨김 4개    report.pdf — PDF · 4.2 MB    ● prod  L"
 *
 * 집계는 **화면에 보이는 목록** 기준이다 — 예전엔 숨김 파일·빠른 필터로 가린 항목까지
 * 세서 "45개" 라고 하는데 목록엔 15개만 있었다. 가려진 수는 따로 알리고, 숨김 개수는
 * 눌러서 바로 숨김 파일을 켜고 끈다(패널이 좁으면 그 토글이 `보기` 메뉴 안에 있다).
 */
export function StatusBar() {
  const { t } = useTranslation();
  const activeId = usePanes((s) => s.activePane);
  const tab = usePanes((s) => activeTab(s, activeId));
  const singlePane = useUI((s) => s.singlePane);
  const kToggleHidden = useKeyHint("view.toggleHidden");

  const src = tab.location.source;
  const sourceLabel = useHostLabel(src);
  const connState = useConnections((s) =>
    src.kind === "ssh" ? s.active[src.connection_id]?.state : undefined,
  );

  const displayed = useMemo(() => computeDisplayed(tab), [tab]);

  // 왼쪽: 보이는 파일/폴더 수 + 총 용량(파일만) + 가려진 수 + 선택.
  const visible = useMemo(
    () => displayed.filter((e) => !isParentEntry(e)),
    [displayed],
  );
  const { files, folders } = useMemo(
    () => summarizeEntries(visible),
    [visible],
  );
  // 총 용량은 파일만 — SFTP 는 폴더에도 디렉터리 메타 크기(4 KiB 등)를 실어 와서
  // summarizeEntries 의 합계에 섞이면 의미 없는 값이 더해진다.
  const totalSize = useMemo(
    () =>
      visible.reduce(
        (sum, e) => (e.kind === "dir" ? sum : sum + (e.size ?? 0)),
        0,
      ),
    [visible],
  );
  // 가려진 항목 — 필터로 빠진 것과 숨김이라 빠진 것을 나눠 센다(필터 먼저 적용).
  const { hiddenCount, filteredOut } = useMemo(() => {
    const q = tab.filter.toLowerCase();
    const matched = q
      ? tab.entries.filter((e) => e.name.toLowerCase().includes(q))
      : tab.entries;
    return {
      hiddenCount: matched.filter((e) => e.hidden).length,
      filteredOut: tab.entries.length - matched.length,
    };
  }, [tab.entries, tab.filter]);
  const selectedCount = tab.selected.size;
  // 선택 용량 — 폴더는 "크기 계산"으로 구해 둔 값(dirSizes)이 있으면 더한다. 예전엔
  // 폴더만 고르면 목록에 크기가 보이는데도 "(0 B)" 였다. 아직 모르는 폴더가 섞이면
  // 합계 앞에 "≥" 를 붙여 하한임을 알린다.
  const { selectedSize, sizeUnknown } = useMemo(() => {
    let sum = 0;
    let unknown = false;
    for (const e of tab.entries as Entry[]) {
      if (!tab.selected.has(e.name)) continue;
      // 폴더는 "크기 계산" 결과만 — 원격 폴더의 메타 크기(4 KiB)는 재귀 크기가 아니다.
      const size = e.kind === "dir" ? tab.dirSizes[e.name] : e.size;
      if (size != null) sum += size;
      else if (e.kind === "dir") unknown = true;
    }
    return { selectedSize: sum, sizeUnknown: unknown };
  }, [tab.entries, tab.selected, tab.dirSizes]);

  // 가운데: 커서가 올라간 단일 항목(".." 제외)의 상세.
  const focused = tab.cursorIndex >= 0 ? displayed[tab.cursorIndex] : undefined;
  const focusedMeta =
    focused && !isParentEntry(focused)
      ? [
          kindLabel(focused),
          focused.size != null ? formatSize(focused.size) : null,
          focused.modified_ms != null
            ? formatFullDate(focused.modified_ms)
            : null,
          focused.permissions != null ? formatPerms(focused.permissions) : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  // 가상 휴지통 — 상세 대신 원래 위치(어디서 지웠는지)가 더 중요하다.
  const trashOriginal =
    focused && isVirtualTrash(tab.location)
      ? trashItemFor(focused.name)?.original_path
      : undefined;

  const summary = [
    countLabel(files, folders),
    totalSize > 0 ? formatSize(totalSize) : null,
    filteredOut > 0 ? t("statusbar.filteredOut", { count: filteredOut }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // 크기를 하나도 모르면(계산 안 한 폴더만 선택) 용량은 빼고 개수만.
  const selectedSizeText =
    sizeUnknown && selectedSize === 0
      ? ""
      : ` (${sizeUnknown ? "≥ " : ""}${formatSize(selectedSize)})`;
  const selectedText =
    selectedCount > 0
      ? `${t("statusbar.selected", { count: selectedCount })}${selectedSizeText}`
      : null;

  // 숨김 개수 버튼 — 숨기는 중이면 "숨김 N개"(누르면 표시), 보이는 중이면
  // "숨김 N개 표시 중"(누르면 다시 숨김). 숨김 항목이 없으면 렌더하지 않는다.
  const hiddenLabel = tab.showHidden
    ? t("statusbar.hiddenShown", { count: hiddenCount })
    : t("statusbar.hiddenCount", { count: hiddenCount });
  const hiddenTitle = tab.showHidden
    ? t("statusbar.hideHiddenTitle", { key: kToggleHidden })
    : t("statusbar.showHiddenTitle", { key: kToggleHidden });

  const paneLetter = activeId === "left" ? "L" : "R";
  const paneTitle =
    activeId === "left" ? t("statusbar.paneLeft") : t("statusbar.paneRight");
  const stateLabel =
    src.kind === "ssh"
      ? connState?.kind === "error"
        ? connState.message
        : t(`sidebar.state.${connState?.kind ?? "disconnected"}`)
      : null;

  return (
    <footer
      onKeyDown={keepButtonActivationLocal}
      onClick={releaseFocusAfterMouse}
      className="flex h-6 items-center gap-3 border-t border-border px-3 text-meta text-fg-muted"
    >
      <span className="flex min-w-0 max-w-[50%] items-center gap-1.5">
        <span
          className="min-w-0 truncate"
          title={[summary, selectedText].filter(Boolean).join(" · ")}
        >
          {summary}
        </span>
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={() => usePanes.getState().toggleShowHidden(activeId)}
            aria-pressed={tab.showHidden}
            title={hiddenTitle}
            // 바 높이 전체(테두리 뺀 23px)를 누르는 영역으로 — min-h-6 은 바를 25px 로
            // 밀어 숨김 파일 유무에 따라 하단 바가 1px 흔들렸다.
            className="h-full shrink-0 rounded px-1 hover:bg-border hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            {hiddenLabel}
          </button>
        )}
        {selectedText && (
          <span className="min-w-0 shrink-0 truncate text-fg">
            {selectedText}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-center">
        {focused && focusedMeta && (
          <>
            <span className="font-mono text-fg" title={focused.name}>
              {focused.name}
            </span>
            {" — "}
            {trashOriginal
              ? `${t("statusbar.originalPath")} ${trashOriginal}`
              : focusedMeta}
          </>
        )}
      </span>
      <span
        className="flex min-w-0 max-w-[25%] items-center gap-1.5"
        title={stateLabel ? `${sourceLabel} — ${stateLabel}` : sourceLabel}
        data-testid="statusbar-source"
      >
        {/* 탭·PathBar 원격 배지와 같은 어휘 — Server 아이콘 + 호스트 라벨, 상태는 StateDot. */}
        {src.kind === "ssh" && (
          <>
            <StateDot state={connState ?? { kind: "disconnected" }} />
            <Server size={12} className="shrink-0" aria-hidden="true" />
          </>
        )}
        <span className="min-w-0 truncate">{sourceLabel}</span>
        {!singlePane && (
          <span
            className="shrink-0 rounded-[3px] bg-accent/15 px-1 py-0.5 text-[10px] font-medium leading-none text-accent"
            title={paneTitle}
            aria-label={paneTitle}
          >
            {paneLetter}
          </span>
        )}
      </span>
    </footer>
  );
}
