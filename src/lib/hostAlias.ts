import type { SavedHost } from "@/types/bindings";

/**
 * 연결 alias 해석 — ad-hoc 연결의 alias 는 `user@host:port` 형식이다
 * (백엔드 `connection_open_adhoc` 이 그렇게 만든다). 즐겨찾기/북마크는 이 alias 를
 * 그대로 저장하므로, 나중에 재접속하려면 다시 host/user/port 로 되돌려야 한다.
 *
 * `~/.ssh/config` 의 alias 는 이 형식이 아니라 그냥 이름 — 그건 파싱 대상이 아니다.
 */

/** ad-hoc alias 를 분해한 결과. */
export interface AdHocAliasParts {
  user: string;
  host: string;
  port: number;
}

/**
 * `user@host:port` 형태의 ad-hoc alias 를 분해. 형식이 아니면 `null`.
 *
 * host 가 IPv6 리터럴(`::1`)일 수 있어 port 는 **마지막** `:` 기준으로 자르고,
 * 숫자(1..65535)일 때만 인정한다. user 는 **첫** `@` 기준.
 */
export function parseAdHocAlias(alias: string): AdHocAliasParts | null {
  const at = alias.indexOf("@");
  if (at <= 0) return null;
  const user = alias.slice(0, at);
  const rest = alias.slice(at + 1);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return null;
  const host = rest.slice(0, colon);
  const portText = rest.slice(colon + 1);
  if (!/^\d+$/.test(portText)) return null;
  const port = Number.parseInt(portText, 10);
  if (port < 1 || port > 65535) return null;
  if (!host) return null;
  return { user, host, port };
}

/**
 * 이 alias 로 재접속할 저장된 호스트 찾기.
 *
 * 1. alias 그대로 일치 (사용자가 지정한 alias 로 저장한 경우)
 * 2. ad-hoc alias 를 분해해 user/host/port 가 같은 저장 호스트
 *    (저장 시 사용자가 alias 를 "nas" 처럼 바꿨어도 연결 alias 는
 *    `user@host:port` 라서 1번으로는 못 찾는다)
 */
export function findSavedHostForAlias(
  alias: string,
  hosts: SavedHost[],
): SavedHost | undefined {
  const exact = hosts.find((h) => h.alias === alias);
  if (exact) return exact;
  const parts = parseAdHocAlias(alias);
  if (!parts) return undefined;
  return hosts.find(
    (h) =>
      h.user === parts.user && h.host === parts.host && h.port === parts.port,
  );
}

/**
 * 저장된 호스트가 없을 때 ad-hoc 다이얼로그를 채울 임시 프리필 — alias 를 분해한
 * 값만 담는다. 실제로 저장된 호스트가 아니므로 vault(저장된 비밀번호) 조회는
 * 빈 결과가 나오고, 사용자가 "저장" 을 켜야만 저장된다.
 */
export function prefillFromAlias(alias: string): SavedHost | null {
  const parts = parseAdHocAlias(alias);
  if (!parts) return null;
  return {
    alias,
    host: parts.host,
    port: parts.port,
    user: parts.user,
    key_path: null,
  };
}
