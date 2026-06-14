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
}

export type MenuEntry = MenuItem | { kind: "separator" };

interface State {
  open: boolean;
  x: number;
  y: number;
  items: MenuEntry[];
  openAt: (x: number, y: number, items: MenuEntry[]) => void;
  close: () => void;
}

export const useContextMenu = create<State>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  openAt: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false, items: [] }),
}));

/** separator 판별 타입 가드. */
export function isSeparator(e: MenuEntry): e is { kind: "separator" } {
  return "kind" in e && e.kind === "separator";
}
