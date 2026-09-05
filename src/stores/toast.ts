import { create } from "zustand";

/**
 * 전역 토스트 큐.
 *
 * - 단일 슬롯이 아니라 스택 — 연속 에러가 서로 덮어쓰지 않음.
 * - kind 로 스타일 구분 (info/success/error). 기본 info — 기존 호출부 무변경 호환.
 * - error 는 **자동으로 사라지지 않는다** — 읽기 전에 증발하던 문제(연결 실패 상세는
 *   여러 줄이라 6초로는 부족했다). X 로 닫는다 (DESIGN "에러는 사라지지 않음").
 */
export type ToastKind = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

/** 표시 지속시간(ms). null = 자동 소멸 없음(수동 닫기). */
const DURATION_MS: Record<ToastKind, number | null> = {
  info: 3000,
  success: 3000,
  error: null,
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
    set((s) => {
      const next = [...s.toasts, { id, message: msg, kind }];
      // 상한을 넘으면 **자동 소멸하는 것**부터 밀어낸다 — 예전에는 성공 토스트가
      // 밀려들면서 정작 읽어야 할 에러를 밀어냈다.
      while (next.length > MAX_VISIBLE) {
        const victim = next.findIndex((t) => DURATION_MS[t.kind] !== null);
        next.splice(victim >= 0 ? victim : 0, 1);
      }
      return { toasts: next };
    });
    const ms = DURATION_MS[kind];
    if (ms !== null) {
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, ms);
    }
  },
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}));

/** 호출부 주입용 타입 — fileActions 등이 toast fn 을 인자로 받을 때 사용. */
export type ToastFn = (msg: string, kind?: ToastKind) => void;
