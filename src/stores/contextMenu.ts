import { create } from "zustand";
import type { ReactNode } from "react";

/**
 * 우클릭 컨텍스트 메뉴 상태. 위치(x,y) + 항목 배열만 보관 — 렌더/키보드/위치보정은
 * `components/ContextMenu.tsx` 가 담당. 항목 빌더는 `lib/entryMenu.tsx` / 호출부.
 *
 * 항목의 `onSelect` 은 전역 store(panes/ui-dialogs/toast) 를 직접 읽는 액션이라
 * 추가 인자 없이 닫힌 뒤 실행된다. `children` 으로 1-레벨 서브메뉴 지원.
 */
export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** 우측에 회색으로 표시되는 단축키 힌트 (표시 전용). */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children?: MenuEntry[];
  /**
   * 지연 서브메뉴 — 펼칠 때 1회 호출해 children 을 가져온다(Windows 셸 메뉴 등 비싼 조회).
   * children 과 동시 사용 금지. 빈 배열 반환 시 "(none)" 표시.
   */
  loadChildren?: () => Promise<MenuEntry[]>;
}

export type MenuEntry = MenuItem | { kind: "separator" };

interface State {
  open: boolean;
  x: number;
  y: number;
  items: MenuEntry[];
  /** 이 메뉴 오픈의 토큰 — openAt 마다 증가. 비동기 appendItems 가 stale 인지 판별. */
  seq: number;
  /** 닫힐 때 1회 호출 — 셸 메뉴 세션 정리(미선택 시 취소) 등에 사용. */
  onClose: (() => void) | undefined;
  openAt: (
    x: number,
    y: number,
    items: MenuEntry[],
    onClose?: () => void,
  ) => number;
  /** 같은 메뉴(seq 일치)가 아직 열려 있으면 항목을 뒤에 덧붙인다(비동기 셸 메뉴용). */
  appendItems: (seq: number, extra: MenuEntry[], onClose?: () => void) => void;
  close: () => void;
}

export const useContextMenu = create<State>((set, get) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  seq: 0,
  onClose: undefined,
  openAt: (x, y, items, onClose) => {
    const seq = get().seq + 1;
    set({ open: true, x, y, items, onClose, seq });
    return seq;
  },
  appendItems: (seq, extra, onClose) => {
    const s = get();
    if (!s.open || s.seq !== seq || extra.length === 0) return;
    set({
      items: [...s.items, ...extra],
      // 셸 세션 정리 콜백을 합성 — 기존 onClose 도 보존.
      onClose: onClose
        ? () => {
            s.onClose?.();
            onClose();
          }
        : s.onClose,
    });
  },
  close: () => {
    const cb = get().onClose;
    set({ open: false, items: [], onClose: undefined });
    cb?.();
  },
}));

/** separator 판별 타입 가드. */
export function isSeparator(e: MenuEntry): e is { kind: "separator" } {
  return "kind" in e && e.kind === "separator";
}
