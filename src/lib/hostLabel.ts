import type { SourceId } from "@/types/bindings";
import { useHostNicknames, type NickMap } from "@/stores/hostNicknames";
import { useConnections } from "@/stores/connections";

/**
 * 소스의 표시 라벨 — 로컬은 "Local", SSH 는 우선순위:
 *   사용자 별명(nickname) → connection alias → `user@host_ip`(폴백).
 *
 * 순수 함수(테스트용). 반응형은 useHostLabel.
 */
export function resolveHostLabel(
  source: SourceId,
  nicks: NickMap,
  aliasOf: (connectionId: string) => string | undefined,
): string {
  if (source.kind === "local") return "Local";
  const alias = aliasOf(source.connection_id);
  const nick = alias ? nicks[alias] : undefined;
  return nick ?? alias ?? `${source.user}@${source.host_ip}`;
}

/** 반응형 hook — nickname/connection 변경 시 재렌더. */
export function useHostLabel(source: SourceId): string {
  const nicks = useHostNicknames((s) => s.byAlias);
  const active = useConnections((s) => s.active);
  return resolveHostLabel(source, nicks, (id) => active[id]?.alias);
}

/** alias 문자열의 표시명 — 별명 있으면 별명, 없으면 alias 그대로(Recent/Sidebar 용). */
export function aliasLabel(alias: string, nicks: NickMap): string {
  return nicks[alias] ?? alias;
}
