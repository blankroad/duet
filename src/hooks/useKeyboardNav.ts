import { useEffect } from "react";
import {
  usePanes,
  activeTab,
  computeDisplayed,
  isParentEntry,
} from "@/stores/panes";
import type { PaneId } from "@/stores/panes";
import { useContextMenu } from "@/stores/contextMenu";
import { useClipboard } from "@/stores/clipboard";
import { useUIDialogs } from "@/stores/ui-dialogs";
import { usePalette } from "@/stores/palette";
import { useSearch } from "@/stores/search";
import { useUI } from "@/stores/ui";
import { useKeymap } from "@/stores/keymap";
import { useCommands } from "@/stores/commands";
import { formatKeyEvent } from "@/lib/keyEvent";

/**
 * Esc 의 주인이 따로 있는가 — 다이얼로그·팔레트·검색·QuickLook 이 열려 있으면 그쪽이
 * 먼저 닫혀야 하므로 목록은 Esc 를 건드리지 않는다. (컨텍스트 메뉴는 위에서 이미 걸러짐.)
 */
function escapeOwnedByOverlay(): boolean {
  return (
    useUIDialogs.getState().dialog.kind !== "none" ||
    usePalette.getState().isOpen ||
    useSearch.getState().isOpen ||
    useUI.getState().quickLookOpen
  );
}

/**
 * Shift 범위 선택의 기준점 — `pane:tabIndex` → displayed 인덱스.
 * Shift 없이 커서를 옮기면 지운다(다음 Shift 이동이 새 기준을 잡게).
 */
const anchors = new Map<string, number>();

function anchorKey(id: PaneId): string {
  const p = usePanes.getState().panes[id];
  return `${id}:${p.activeTabIndex}`;
}

/**
 * 타이핑으로 이름 점프(type-ahead) — 탐색기/파인더/ForkLift 의 근육 기억.
 * 1초 안에 이어 친 글자는 접두사로 누적된다. `/` 는 계속 빠른 필터를 연다.
 */
const TYPEAHEAD_RESET_MS = 1000;
let typeahead = { buf: "", at: 0 };

/**
 * 그 키에 이미 커맨드가 매여 있나 — 사용자가 맨 글자 하나를 단축키로 바꿔 뒀다면
 * 커맨드가 이기고 이름 점프는 하지 않는다(둘 다 실행되면 안 된다).
 */
function boundToCommand(e: KeyboardEvent): boolean {
  const keystr = formatKeyEvent(e);
  if (!keystr) return false;
  if (useKeymap.getState().bindings.some((b) => b.key === keystr)) return true;
  const { builtins, dynamic } = useCommands.getState();
  return [...builtins, ...dynamic].some(
    (c) => c.defaultKey === keystr || c.altKeys?.includes(keystr),
  );
}

/** 접두사로 시작하는 첫 항목으로 커서 이동. 없으면 아무 일도 안 한다. */
function typeaheadJump(id: PaneId, ch: string): void {
  const now = Date.now();
  typeahead =
    now - typeahead.at > TYPEAHEAD_RESET_MS
      ? { buf: ch, at: now }
      : { buf: typeahead.buf + ch, at: now };
  const state = usePanes.getState();
  const tab = activeTab(state, id);
  const list = computeDisplayed(tab);
  const prefix = typeahead.buf.toLowerCase();
  // 같은 글자를 반복하면 다음 후보로 순환(탐색기 동작).
  const start =
    typeahead.buf.length === 1 ? tab.cursorIndex + 1 : tab.cursorIndex;
  for (let i = 0; i < list.length; i++) {
    const idx = (Math.max(0, start) + i) % list.length;
    const e = list[idx];
    if (e && !isParentEntry(e) && e.name.toLowerCase().startsWith(prefix)) {
      state.setCursor(id, idx);
      return;
    }
  }
}

/** 한 페이지 = 뷰포트에 들어가는 행 수(대략). 그리드는 행 단위로 맞춘다. */
function pageStep(tab: ReturnType<typeof activeTab>): number {
  const rows = 12;
  return tab.viewMode === "grid" ? rows * Math.max(1, tab.gridCols) : rows;
}

/** 커서 이동 + Shift 면 기준점부터 범위 선택. */
function moveWithSelection(id: PaneId, delta: number, shift: boolean): void {
  const state = usePanes.getState();
  const tab = activeTab(state, id);
  const len = computeDisplayed(tab).length;
  const next = Math.max(0, Math.min(len - 1, tab.cursorIndex + delta));
  applyMove(id, next, shift, tab.cursorIndex);
}

/** 특정 인덱스로 점프 + Shift 면 범위 선택. */
function jumpWithSelection(id: PaneId, index: number, shift: boolean): void {
  const state = usePanes.getState();
  const tab = activeTab(state, id);
  const len = computeDisplayed(tab).length;
  const next = Math.max(0, Math.min(len - 1, index));
  applyMove(id, next, shift, tab.cursorIndex);
}

function applyMove(
  id: PaneId,
  next: number,
  shift: boolean,
  from: number,
): void {
  const state = usePanes.getState();
  const key = anchorKey(id);
  if (shift) {
    const anchor = anchors.get(key) ?? from;
    anchors.set(key, anchor);
    state.setCursor(id, next);
    state.selectRange(id, anchor, next);
  } else {
    anchors.delete(key);
    state.setCursor(id, next);
  }
}

/**
 * 글로벌 키보드 네비게이션 (활성 패널 대상).
 * DESIGN.md 키 바인딩 표 — MVP-0 항목.
 *
 * input/textarea/contenteditable 포커스 중에는 무시.
 * 다른 단축키 (Ctrl+B, Ctrl+Q 등)는 useGlobalShortcuts (Task 13)에서.
 */
export function useKeyboardNav(
  onActivate: (paneId: PaneId) => void,
  onUp: (paneId: PaneId) => void,
  onQuickLook: (paneId: PaneId) => void,
) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      // 우클릭 메뉴가 열려 있으면 메뉴가 키(↑↓/Enter/Esc)를 처리 — 뒤 파일 목록은 안 건드림.
      if (useContextMenu.getState().open) return;

      const state = usePanes.getState();
      const id = state.activePane;
      const tab = activeTab(state, id);
      // grid 뷰에서 ↑↓ 는 한 행(=컬럼 수)만큼, ←→ 는 1칸. 그 외 뷰는 단일 컬럼.
      const rowStep = tab.viewMode === "grid" ? Math.max(1, tab.gridCols) : 1;

      switch (e.key) {
        // Esc — 되돌리기 계열. preventDefault 하지 않는다(놓친 오버레이가 있어도 살게).
        case "Escape": {
          if (escapeOwnedByOverlay()) break;
          // 1) 잘라내기 대기 취소가 먼저 — 흐리게 표시된 항목을 원래대로.
          //    (탐색기와 같은 관례. 취소했는데 계속 흐린 게 이 처리가 없던 버그.)
          const clip = useClipboard.getState();
          if (clip.entry?.mode === "move") {
            clip.clear();
            break;
          }
          // 2) 선택 해제 (DESIGN.md 키 바인딩 표).
          if (tab.selected.size > 0) state.setSelected(id, []);
          break;
        }
        case "ArrowDown":
          e.preventDefault();
          moveWithSelection(id, rowStep, e.shiftKey);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveWithSelection(id, -rowStep, e.shiftKey);
          break;
        // Home/End/PageUp/PageDown — 1만 항목 폴더에서 ↓ 를 1만 번 누르지 않게.
        case "Home":
          e.preventDefault();
          jumpWithSelection(id, 0, e.shiftKey);
          break;
        case "End":
          e.preventDefault();
          jumpWithSelection(id, computeDisplayed(tab).length - 1, e.shiftKey);
          break;
        case "PageDown":
          e.preventDefault();
          moveWithSelection(id, pageStep(tab), e.shiftKey);
          break;
        case "PageUp":
          e.preventDefault();
          moveWithSelection(id, -pageStep(tab), e.shiftKey);
          break;
        // Insert — TC 관례: 토글하고 한 칸 내려간다(연속 선택).
        case "Insert": {
          e.preventDefault();
          const entry = computeDisplayed(tab)[tab.cursorIndex];
          if (entry && !isParentEntry(entry))
            state.toggleSelected(id, entry.name);
          state.moveCursor(id, 1);
          anchors.delete(anchorKey(id));
          break;
        }
        case "ArrowLeft":
          if (tab.viewMode === "grid") {
            e.preventDefault();
            state.moveCursor(id, -1);
          }
          break;
        case "ArrowRight":
          if (tab.viewMode === "grid") {
            e.preventDefault();
            state.moveCursor(id, 1);
          }
          break;
        case "Enter":
          e.preventDefault();
          if (tab.cursorIndex >= 0) onActivate(id);
          break;
        case "Backspace":
          e.preventDefault();
          onUp(id);
          break;
        case "Tab":
          e.preventDefault();
          state.setActivePane(id === "left" ? "right" : "left");
          break;
        case " ":
          // Shift+Space = 폴더 크기 계산(file.calcSize, 전역 단축키) — 여기선 무시.
          if (e.shiftKey) break;
          e.preventDefault();
          // Finder 관례: Space = Quick Look, Ctrl/Cmd+Space = 선택 토글.
          if (e.ctrlKey || e.metaKey) {
            if (tab.cursorIndex >= 0) {
              // displayed 기준 인덱싱(정렬/필터/".." 반영). ".." 는 선택 불가.
              const entry = computeDisplayed(tab)[tab.cursorIndex];
              if (entry && !isParentEntry(entry))
                state.toggleSelected(id, entry.name);
            }
          } else {
            onQuickLook(id);
          }
          break;
      }

      // 위 switch 가 처리하지 않은 **문자 한 글자** → 이름 점프.
      // 수식키 조합은 커맨드 몫이라 건드리지 않는다.
      if (
        e.key.length === 1 &&
        e.key !== " " &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !boundToCommand(e)
      ) {
        e.preventDefault();
        typeaheadJump(id, e.key);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onActivate, onUp, onQuickLook]);
}
