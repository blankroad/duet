import { commands } from "@/types/bindings";
import type {
  ConnectionDto,
  DuetError,
  Location,
  SourceId,
} from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { usePanes, type PaneId, type TabState } from "@/stores/panes";
import { useSavedHosts } from "@/stores/savedHosts";
import { useVault } from "@/stores/vault";
import {
  aliasFromConnectionId,
  findSavedHostForAlias,
  prefillFromAlias,
} from "@/lib/hostAlias";

/**
 * 끊긴 SSH 탭 되살리기 — 배너 "재연결" 의 store 측 로직.
 *
 * 재연결하면 백엔드가 **새** connection_id 를 준다. 예전 id 를 가리키던 탭(양쪽
 * 패널, 비활성 탭 포함)을 새 id 로 바꿔 끼우지 않으면, 재연결한 탭 하나만 살아나고
 * 나머지는 계속 "연결 끊김" 배너를 띄운 채 남았다.
 */

export type SshSource = Extract<SourceId, { kind: "ssh" }>;

/** 이 id 의 연결이 쓸 수 있거나 백엔드가 살리는 중인가 (그 탭은 건드리지 않는다). */
function isAliveOrRecovering(id: string): boolean {
  const s = useConnections.getState().active[id]?.state.kind;
  return s === "connected" || s === "connecting";
}

/** 이 위치가 `alias` 의 죽은 연결을 가리키면 새 source 로 바꾼 위치, 아니면 그대로. */
function rebindLocation(
  loc: Location,
  alias: string,
  source: SshSource,
): Location {
  const src = loc.source;
  if (src.kind !== "ssh") return loc;
  if (src.connection_id === source.connection_id) return loc;
  if (aliasFromConnectionId(src.connection_id) !== alias) return loc;
  if (isAliveOrRecovering(src.connection_id)) return loc;
  return { ...loc, source };
}

/**
 * 탭의 현재 위치·뒤로가기 기록·아카이브 복귀 위치를 **각각** 다시 묶는다 — 지금은
 * 로컬을 보고 있어도 기록 속 SSH 위치가 죽은 연결이면 뒤로 가기가 실패했다.
 */
function rebindTab(tab: TabState, alias: string, source: SshSource): TabState {
  const location = rebindLocation(tab.location, alias, source);
  let historyChanged = false;
  const stack = tab.history.stack.map((l) => {
    const next = rebindLocation(l, alias, source);
    if (next !== l) historyChanged = true;
    return next;
  });
  const exitTo = tab.archive
    ? rebindLocation(tab.archive.exitTo, alias, source)
    : undefined;
  const archiveChanged =
    tab.archive !== undefined && exitTo !== tab.archive.exitTo;
  if (location === tab.location && !historyChanged && !archiveChanged)
    return tab;
  return {
    ...tab,
    location,
    history: historyChanged ? { ...tab.history, stack } : tab.history,
    archive:
      tab.archive && archiveChanged && exitTo
        ? { ...tab.archive, exitTo }
        : tab.archive,
  };
}

/**
 * `alias` 의 죽은 연결(끊김·종료·재시작 복원)을 가리키는 모든 탭을 `source` 로
 * 다시 묶는다. 현재 탭·뒤로가기 기록까지 바꾼다.
 *
 * @returns `panes`: 활성 탭이 바뀐 패널 — 화면에 보이는 목록이라 호출부가 새로
 *   읽어야 한다(비활성 탭은 탭 전환 시 새로 읽힌다). `tabs`: 다시 묶은 탭 수.
 */
export function rebindHostTabs(
  alias: string,
  source: SshSource,
): { panes: PaneId[]; tabs: number } {
  const changed: PaneId[] = [];
  let count = 0;
  usePanes.setState((s) => {
    let panes = s.panes;
    for (const id of ["left", "right"] as const) {
      const p = panes[id];
      let touched = false;
      const tabs = p.tabs.map((t, i) => {
        const next = rebindTab(t, alias, source);
        if (next !== t) {
          touched = true;
          count += 1;
          // 보이는 목록을 다시 읽어야 하는 건 현재 위치가 바뀐 활성 탭뿐.
          if (i === p.activeTabIndex && next.location !== t.location)
            changed.push(id);
        }
        return next;
      });
      if (touched) panes = { ...panes, [id]: { ...p, tabs } };
    }
    return panes === s.panes ? s : { panes };
  });
  return { panes: changed, tabs: count };
}

/**
 * 더는 어느 탭도 가리키지 않는 `alias` 의 죽은 연결 entry 를 store 에서 지운다 —
 * 재연결할 때마다 error entry 가 쌓이지 않게.
 */
export function pruneDeadConnections(alias: string): void {
  const { active, removeActive } = useConnections.getState();
  // 현재 위치뿐 아니라 뒤로가기 기록·아카이브 복귀 위치가 참조하는 id 도 "사용 중".
  const used = new Set<string>();
  const mark = (l: Location) => {
    if (l.source.kind === "ssh") used.add(l.source.connection_id);
  };
  for (const p of Object.values(usePanes.getState().panes)) {
    for (const t of p.tabs) {
      mark(t.location);
      t.history.stack.forEach(mark);
      if (t.archive) mark(t.archive.exitTo);
    }
  }
  for (const c of Object.values(active)) {
    if (c.alias !== alias || used.has(c.id)) continue;
    if (c.state.kind === "error" || c.state.kind === "disconnected")
      removeActive(c.id);
  }
}

/**
 * 대화상자 없이 다시 연결해 보기의 결과.
 *
 * - `ok`: 연결됨
 * - `dialog`: 사람이 개입해야 함 (비밀번호·호스트 키·잠긴 vault·모르는 alias) —
 *   `error` 가 있으면 대화상자가 처음부터 그 이유를 보여 준다
 * - `failed`: 서버에 닿지 않음 등 — 비밀번호를 물어도 소용없으니 대화상자 없이 알린다
 */
export type QuickReconnectResult =
  | { kind: "ok"; dto: ConnectionDto }
  | { kind: "dialog"; error: DuetError | null }
  | { kind: "failed"; error: DuetError };

/** 사람이 답해야 풀리는 실패 — 대화상자로 넘긴다. 나머지는 네트워크/서버 쪽 문제. */
function needsHuman(e: DuetError): boolean {
  return (
    e.kind === "AuthFailed" ||
    e.kind === "HostKeyUnverified" ||
    e.kind === "NeedPassword"
  );
}

/**
 * 이미 한 번 접속했던 호스트를 대화상자 없이 다시 연결한다 — 키/에이전트, 또는
 * vault 에 저장된 비밀번호(백엔드가 직접 꺼내 씀, 평문은 프론트로 오지 않음 §5).
 *
 * 호스트 키는 **신뢰하지 않는다** (trust/replace = false) — 바뀌었으면 `dialog` 로
 * 넘어가 사용자가 fingerprint 를 보고 결정한다.
 */
export async function quickReconnect(
  alias: string,
): Promise<QuickReconnectResult> {
  const settle = (
    r:
      | { status: "ok"; data: ConnectionDto }
      | { status: "error"; error: DuetError },
  ): QuickReconnectResult => {
    if (r.status === "ok") return { kind: "ok", dto: r.data };
    return needsHuman(r.error)
      ? { kind: "dialog", error: r.error }
      : { kind: "failed", error: r.error };
  };

  if (useConnections.getState().hosts.some((h) => h.alias === alias)) {
    return settle(await commands.connectionOpen(alias, null, false, false));
  }

  const saved = findSavedHostForAlias(alias, useSavedHosts.getState().hosts);
  const host = saved ?? prefillFromAlias(alias);
  if (!host) return { kind: "dialog", error: null };

  const vault = useVault.getState();
  // 잠긴 vault 에 비밀번호가 있을 수 있는 저장 호스트 — 키 없이 한 번 실패시켜
  // 서버 인증 실패 횟수만 늘리지 말고, 잠금 해제 버튼이 있는 대화상자로 바로 간다.
  if (saved && vault.exists && !vault.unlocked && !saved.key_path) {
    return { kind: "dialog", error: null };
  }
  return settle(
    await commands.connectionOpenAdhoc({
      host: host.host,
      port: host.port,
      user: host.user,
      keyPath: host.key_path ?? null,
      password: null,
      savedPasswordAlias: saved && vault.unlocked ? saved.alias : null,
      trustHostKey: false,
      replaceChangedHostKey: false,
    }),
  );
}
