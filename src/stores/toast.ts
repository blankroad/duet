import { create } from "zustand";
import { useNotices } from "@/stores/notices";

/**
 * 전역 토스트 큐.
 *
 * - 단일 슬롯이 아니라 스택 — 연속 에러가 서로 덮어쓰지 않음.
 * - kind 로 스타일 구분 (info/success/warning/error). 기본 info — 기존 호출부 무변경 호환.
 * - 모든 토스트가 자동으로 사라진다. 오류·경고는 더 오래(8초/6초) 보이고, 사라진 뒤에도
 *   알림 기록(`stores/notices`)에 남아 상태바 배지에서 다시 볼 수 있다.
 *   (예전엔 오류가 X 를 누를 때까지 화면에 남아 작업을 가렸다.)
 */
export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface ToastOptions {
  /** 원문(백엔드 오류 등) — 알림 기록의 "자세히"에만 보인다. */
  detail?: string | undefined;
}

/** 표시 지속시간(ms). */
const DURATION_MS: Record<ToastKind, number> = {
  info: 3000,
  success: 3000,
  warning: 6000,
  error: 8000,
};

/** 알림 기록에 남기는 종류. */
const LOGGED: Partial<Record<ToastKind, "error" | "warning">> = {
  error: "error",
  warning: "warning",
};

/** 동시 표시 상한 — 초과 시 가장 오래된 것부터 밀려남. */
const MAX_VISIBLE = 4;

interface State {
  toasts: ToastItem[];
  show: (msg: string, kind?: ToastKind, opts?: ToastOptions) => void;
  pause: (id: number) => void;
  resume: (id: number) => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

let seq = 0;

interface DismissTimer {
  timer: ReturnType<typeof setTimeout> | undefined;
  remaining: number;
  startedAt: number;
}

const timers = new Map<number, DismissTimer>();

function clearTimer(id: number) {
  const entry = timers.get(id);
  if (entry) clearTimeout(entry.timer);
  timers.delete(id);
}

function startTimer(id: number, remaining: number) {
  timers.set(id, {
    remaining,
    startedAt: Date.now(),
    timer: setTimeout(() => useToast.getState().dismiss(id), remaining),
  });
}

export const useToast = create<State>((set, get) => ({
  toasts: [],
  show: (msg, kind = "info", opts) => {
    seq += 1;
    const id = seq;
    const logAs = LOGGED[kind];
    if (logAs)
      useNotices
        .getState()
        .add({ kind: logAs, message: msg, detail: opts?.detail });
    set((s) => {
      const next = [...s.toasts, { id, message: msg, kind }];
      // 상한을 넘으면 기록에 안 남는 것(정보·성공)부터 밀어낸다 — 성공 토스트가 밀려들면서
      // 정작 읽어야 할 오류를 밀어내지 않게.
      while (next.length > MAX_VISIBLE) {
        const victim = next.findIndex((t) => !LOGGED[t.kind]);
        const [removed] = next.splice(victim >= 0 ? victim : 0, 1);
        if (removed) clearTimer(removed.id);
      }
      return { toasts: next };
    });
    if (get().toasts.some((t) => t.id === id))
      startTimer(id, DURATION_MS[kind]);
  },
  pause: (id) => {
    const entry = timers.get(id);
    if (!entry || entry.timer === undefined) return;
    clearTimeout(entry.timer);
    entry.remaining = Math.max(
      0,
      entry.remaining - (Date.now() - entry.startedAt),
    );
    entry.timer = undefined;
  },
  resume: (id) => {
    const entry = timers.get(id);
    if (!entry || entry.timer !== undefined) return;
    // 읽기를 마친 뒤 닫기 버튼까지 갈 여유를 남긴다.
    startTimer(id, Math.max(1500, entry.remaining));
  },
  dismiss: (id) => {
    clearTimer(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
  clear: () => {
    for (const id of timers.keys()) clearTimer(id);
    set({ toasts: [] });
  },
}));

/** 호출부 주입용 타입 — fileActions 등이 toast fn 을 인자로 받을 때 사용. */
export type ToastFn = (
  msg: string,
  kind?: ToastKind,
  opts?: ToastOptions,
) => void;
