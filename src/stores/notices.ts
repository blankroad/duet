import { create } from "zustand";

/**
 * 최근 알림 기록 — 오류·경고 토스트는 잠깐 뜨고 사라지는 대신 여기 남는다.
 *
 * 예전엔 오류 토스트가 X 를 누를 때까지 화면에 계속 남아 작업을 가렸다. 이제 토스트는
 * 자동으로 사라지고, 상태바 배지(읽지 않은 개수)를 누르면 이 목록에서 다시 볼 수 있다.
 * 앱을 다시 켜면 비워진다(메모리만 — 원문에 경로가 들어 있어 디스크에 남기지 않는다).
 */
export type NoticeKind = "error" | "warning";

export interface Notice {
  id: number;
  /** 발생 시각 (ms epoch). */
  at: number;
  kind: NoticeKind;
  /** 토스트에 보인 문장. */
  message: string;
  /** 원문(백엔드 오류 등) — "자세히". 없으면 undefined. */
  detail?: string | undefined;
}

/** 보관 상한 — 넘으면 오래된 것부터 버린다. */
const MAX_NOTICES = 50;

interface State {
  items: Notice[];
  /** 마지막으로 목록을 연 뒤 새로 들어온 개수. */
  unread: number;
  add: (n: Omit<Notice, "id" | "at">) => void;
  markAllRead: () => void;
  clear: () => void;
}

let seq = 0;

export const useNotices = create<State>((set) => ({
  items: [],
  unread: 0,
  add: (n) => {
    seq += 1;
    const item: Notice = { ...n, id: seq, at: Date.now() };
    set((s) => ({
      items: [item, ...s.items].slice(0, MAX_NOTICES),
      unread: Math.min(s.unread + 1, MAX_NOTICES),
    }));
  },
  markAllRead: () => set({ unread: 0 }),
  clear: () => set({ items: [], unread: 0 }),
}));
