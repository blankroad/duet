import type { SourceId } from "@/types/bindings";
import {
  useHostNicknames,
  nicknameOf,
  type NickMap,
} from "@/stores/hostNicknames";
import { useConnections } from "@/stores/connections";
import { aliasFromConnectionId } from "@/lib/hostAlias";
import { isRestoredRemote } from "@/stores/panes";
// 앱 부트스트랩(@/i18n)이 아니라 같은 전역 인스턴스를 직접 — 이 모듈을 쓰는 컴포넌트
// 테스트가 react-i18next 를 모킹해도 import 만으로 깨지지 않게.
import i18n from "i18next";

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
  // 연결이 store 에 없어도(재시작 복원 탭 `prod:restored`, 정리된 연결) id 의 마지막
  // `:` 앞이 alias 다 — 없으면 복원 탭이 `@0.0.0.0` 으로 보였다.
  const id = source.connection_id;
  const alias =
    aliasOf(id) ?? (id.includes(":") ? aliasFromConnectionId(id) : undefined);
  const nick = alias ? nicknameOf(nicks, alias) : undefined;
  return nick ?? alias ?? `${source.user}@${source.host_ip}`;
}

/** 반응형 hook — nickname/connection 변경 시 재렌더. */
export function useHostLabel(source: SourceId): string {
  const nicks = useHostNicknames((s) => s.byAlias);
  const active = useConnections((s) => s.active);
  const label = resolveHostLabel(source, nicks, (id) => active[id]?.alias);
  return source.kind === "local" ? i18n.t("source.local") : label;
}

/** 탭·소스 칩이 보여 줄 연결 상태. 로컬은 "local". */
export type SourceState =
  | "local"
  | "connected"
  | "connecting"
  | "disconnected"
  | "error";

export interface SourceStatus {
  remote: boolean;
  /** 표시 라벨 — 별명 → alias → user@ip (로컬은 "로컬"). */
  label: string;
  state: SourceState;
  /** 사람이 읽는 상태 문구 + 오류 메시지 (툴팁용). */
  stateText: string;
  /** `user@host_ip` — 툴팁 보조 정보. 복원 탭처럼 모르면 null. */
  address: string | null;
}

/**
 * 소스의 표시 라벨 + **그 연결 id 의** 연결 상태 — 탭·PathBar 소스 칩이 같은 값을
 * 쓰게 한 곳에 모은다(화면마다 이름·상태가 어긋나지 않게). alias 별 집계
 * (`stateByAlias`)는 쓰지 않는다: 같은 호스트의 다른 살아 있는 연결이 이 탭의 끊김을
 * 가린다.
 */
export function useSourceStatus(source: SourceId): SourceStatus {
  const label = useHostLabel(source);
  const conn = useConnections((s) =>
    source.kind === "ssh" ? s.active[source.connection_id] : undefined,
  );
  if (source.kind === "local") {
    return {
      remote: false,
      label,
      state: "local",
      stateText: label,
      address: null,
    };
  }
  const restored = isRestoredRemote({ source, path: "" });
  const kind = restored ? "disconnected" : (conn?.state.kind ?? "disconnected");
  const stateText =
    conn?.state.kind === "error"
      ? `${i18n.t("source.error")}: ${conn.state.message}`
      : restored
        ? i18n.t("source.restored")
        : i18n.t(`source.${kind}`);
  return {
    remote: true,
    label,
    state: kind,
    stateText,
    address:
      source.host_ip === "0.0.0.0" ? null : `${source.user}@${source.host_ip}`,
  };
}

/** alias 문자열의 표시명 — 별명 있으면 별명, 없으면 alias 그대로(Recent/Sidebar 용). */
export function aliasLabel(alias: string, nicks: NickMap): string {
  return nicknameOf(nicks, alias) ?? alias;
}
