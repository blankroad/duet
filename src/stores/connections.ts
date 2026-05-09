import { create } from "zustand";
import type { ConnectionId } from "@/types/bindings";

/**
 * 연결의 lifecycle 상태.
 *
 * - `disconnected` 는 명시적 종료 또는 초기 상태
 * - `connecting` 은 IPC 진행 중 (connection_open await)
 * - `connected` 는 핸드셰이크 + 인증 성공
 * - `error` 는 연결 시도 실패 또는 도중 끊김 — message 는 toast/sidebar tooltip 용
 */
export type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "error"; message: string };

/**
 * `~/.ssh/config` 에서 가져온 호스트.
 *
 * 백엔드 `SshHostEntryDto` 와 1:1 매칭. `proxy_jump` 의 raw alias 는 노출
 * 안 됨 (CLAUDE.md §5) — `has_proxy_jump` boolean 만 노출.
 */
export interface Host {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  has_proxy_jump: boolean;
}

/**
 * 활성 연결.
 *
 * `id` 는 백엔드 `ConnectionId` (alias + uuid). `alias` 는 같은 호스트에 여러
 * 연결 떴을 때 UI 그룹화용.
 */
export interface ActiveConnection {
  id: ConnectionId;
  alias: string;
  /** 핸드셰이크 시점에 잡은 peer IP (string). same-host 판정 표시용. */
  host_ip: string;
  user: string;
  state: ConnectionState;
}

interface ConnectionsState {
  hosts: Host[];
  active: Record<string, ActiveConnection>;

  setHosts: (hosts: Host[]) => void;
  /** 새 활성 연결 등록 (또는 같은 id 가 있으면 갱신). */
  upsertActive: (conn: ActiveConnection) => void;
  /** 활성 연결 제거. 없는 id 도 OK (idempotent). */
  removeActive: (id: ConnectionId) => void;
  /** 특정 연결의 state 만 갱신. id 가 없으면 no-op. */
  setState: (id: ConnectionId, state: ConnectionState) => void;
  /**
   * alias 별 가장 최근 연결 상태 — Sidebar 가 호스트마다 점 표시할 때 사용.
   * 같은 alias 로 여러 연결이 있으면 우선순위: connected > connecting > error > disconnected.
   */
  stateByAlias: () => Record<string, ConnectionState>;
}

const statePriority = (s: ConnectionState): number => {
  switch (s.kind) {
    case "connected":
      return 3;
    case "connecting":
      return 2;
    case "error":
      return 1;
    case "disconnected":
      return 0;
  }
};

export const useConnections = create<ConnectionsState>((set, get) => ({
  hosts: [],
  active: {},

  setHosts: (hosts) => set({ hosts }),

  upsertActive: (conn) =>
    set((s) => ({ active: { ...s.active, [conn.id]: conn } })),

  removeActive: (id) =>
    set((s) => {
      if (!(id in s.active)) return s;
      const next = { ...s.active };
      delete next[id];
      return { active: next };
    }),

  setState: (id, state) =>
    set((s) => {
      const cur = s.active[id];
      if (!cur) return s;
      return { active: { ...s.active, [id]: { ...cur, state } } };
    }),

  stateByAlias: () => {
    const out: Record<string, ConnectionState> = {};
    for (const conn of Object.values(get().active)) {
      const prev = out[conn.alias];
      if (!prev || statePriority(conn.state) > statePriority(prev)) {
        out[conn.alias] = conn.state;
      }
    }
    return out;
  },
}));
