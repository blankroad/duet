import { create } from "zustand";
import { commands } from "@/types/bindings";
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
  /**
   * 배너 "재연결" 이 진행 중인 alias — 그 호스트의 배너들이 스피너를 띄우고 버튼을
   * 막는다(연타로 연결이 여러 개 생기지 않게). 백엔드 자동 재연결은 `connecting`
   * 상태로 따로 보인다.
   */
  reconnecting: Record<string, true>;

  setHosts: (hosts: Host[]) => void;
  /** 새 활성 연결 등록 (또는 같은 id 가 있으면 갱신). */
  upsertActive: (conn: ActiveConnection) => void;
  /** 활성 연결 제거. 없는 id 도 OK (idempotent). */
  removeActive: (id: ConnectionId) => void;
  /** 특정 연결의 state 만 갱신. id 가 없으면 no-op. */
  setState: (id: ConnectionId, state: ConnectionState) => void;
  /** alias 의 수동 재연결 진행 표시를 켜고 끈다. */
  setReconnecting: (alias: string, on: boolean) => void;
  /**
   * alias 별 가장 최근 연결 상태 — Sidebar 가 호스트마다 점 표시할 때 사용.
   * 같은 alias 로 여러 연결이 있으면 우선순위: connected > connecting > error > disconnected.
   */
  stateByAlias: () => Record<string, ConnectionState>;
  /**
   * alias 로 **재사용 가능한(살아있는)** 연결 찾기 — `connected` 상태만, 같은
   * alias 로 여럿이면 가장 최근에 등록된 것.
   *
   * 백엔드는 재연결을 포기하면 pool 에서 연결을 지우지만(`connection_supervisor`
   * 의 `final_failure`), 프론트 store 는 패널 배너("연결 끊김" + Reconnect) 를
   * 위해 그 entry 를 `error` 상태로 남겨둔다. 그래서 alias 만 보고 고르면 이미
   * 죽은 connection_id 를 집어 IPC 가 `no connection: <id>` 로 실패한다 —
   * 즐겨찾기/호스트-인식 북마크 재접속이 이 방식으로 깨졌었다. alias 로 연결을
   * 찾을 때는 반드시 이 셀렉터를 쓸 것.
   */
  liveByAlias: (alias: string) => ActiveConnection | undefined;
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
  reconnecting: {},

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

  setReconnecting: (alias, on) =>
    set((s) => {
      if (on === isReconnecting(s.reconnecting, alias)) return s;
      // `next[alias] = true` 는 alias 가 `__proto__` 면 프로토타입 setter 로 사라진다 —
      // fromEntries 는 항상 자기 속성으로 만든다.
      const keys = Object.keys(s.reconnecting).filter((k) => k !== alias);
      if (on) keys.push(alias);
      return {
        reconnecting: Object.fromEntries(keys.map((k) => [k, true as const])),
      };
    }),

  stateByAlias: () => {
    // 프로토타입 없는 객체 — `constructor`·`toString` 같은 alias 가 상속 속성과 섞이지 않게.
    const out: Record<string, ConnectionState> = Object.create(null);
    for (const conn of Object.values(get().active)) {
      const prev = out[conn.alias];
      if (!prev || statePriority(conn.state) > statePriority(prev)) {
        out[conn.alias] = conn.state;
      }
    }
    return out;
  },

  liveByAlias: (alias) => {
    let found: ActiveConnection | undefined;
    // 삽입 순서 = 등록 순서. 뒤에서 발견한 것으로 계속 덮어써 "가장 최근" 을 남긴다
    // (재접속하면 새 연결이 뒤에 붙으므로, 앞의 죽은 entry 를 집지 않게).
    for (const conn of Object.values(get().active)) {
      if (conn.alias === alias && conn.state.kind === "connected") found = conn;
    }
    return found;
  },
}));

/**
 * alias 의 수동 재연결이 진행 중인가. `in` 은 상속 속성도 보므로 `constructor`·
 * `toString`·`__proto__` 같은 (유효한) ssh alias 가 늘 "재연결 중"으로 보여 배너에서
 * 재연결 버튼이 사라졌다(remote-NEW-3) — 자기 속성만 본다.
 */
export function isReconnecting(
  reconnecting: Record<string, true>,
  alias: string,
): boolean {
  return Object.hasOwn(reconnecting, alias);
}

/**
 * 이 alias 의 살아있는 연결을 모두 끊는다 — 사이드바/팔레트의 "연결 끊기".
 *
 * 백엔드 `connection_close` 는 재연결 취소·임시 dir 정리까지 하는데 프론트에 호출부가
 * 하나도 없어서, 앱을 끄는 것 말고는 세션을 정리할 방법이 없었다. 그 탭들은 배너의
 * "다시 연결"로 살릴 수 있다.
 */
export async function disconnectAlias(alias: string): Promise<number> {
  // error entry 는 백엔드 pool 에 이미 없다(재연결 포기) — IPC 를 보내도 할 일이 없다.
  const targets = Object.values(useConnections.getState().active).filter(
    (c) => c.alias === alias && c.state.kind !== "error",
  );
  let closed = 0;
  for (const c of targets) {
    const r = await commands.connectionClose(c.id);
    if (r.status === "ok") closed += 1;
  }
  return closed;
}
