import { create } from "zustand";

/**
 * 전역 토스트 큐.
 *
 * - 단일 슬롯이 아니라 스택 — 연속 에러가 서로 덮어쓰지 않음.
 * - kind 로 스타일 구분 (info/success/error). 기본 info — 기존 호출부 무변경 호환.
 * - error 는 더 오래 표시 (읽기 전에 사라지는 문제 완화) + 클릭 dismiss 가능.
 */
export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** 표시 지속시간(ms) — error 는 내용이 길어 여유 있게. */
const DURATION_MS: Record<ToastKind, number> = {
  info: 3000,
  success: 3000,
  error: 6000,
};

/** 동시 표시 상한 — 초과 시 가장 오래된 것부터 밀려남. */
const MAX_VISIBLE = 4;

interface State {
  toasts: ToastItem[];
  show: (msg: string, kind?: ToastKind) => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

let seq = 0;

export const useToast = create<State>((set) => ({
  toasts: [],
  show: (msg, kind = "info") => {
    seq += 1;
    const id = seq;
    set((s) => ({
      toasts: [...s.toasts, { id, message: msg, kind }].slice(-MAX_VISIBLE),
    }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, DURATION_MS[kind]);
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** 호출부 주입용 타입 — fileActions 등이 toast fn 을 인자로 받을 때 사용. */
export type ToastFn = (msg: string, kind?: ToastKind) => void;
