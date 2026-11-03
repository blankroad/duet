import { useTranslation } from "react-i18next";
import { Loader, Unplug, RefreshCw } from "lucide-react";
import {
  usePanes,
  activeTab,
  isRestoredRemote,
  type PaneId,
} from "@/stores/panes";
import { useConnections } from "@/stores/connections";
import { commands } from "@/types/bindings";
import { aliasFromConnectionId } from "@/lib/hostAlias";
import { useHostLabel } from "@/lib/hostLabel";

/**
 * SSH 패널 연결 상태 배너 — 끊긴 연결을 사이드바 점 색이 아니라 패널 안에서
 * 직접 알리고, 그 자리에서 재연결하게 한다.
 *
 * - connected: 렌더 안 함 (평상시 무소음)
 * - connecting(백엔드 자동 재연결) / 배너 재연결 진행 중: 스피너 안내, 버튼 없음
 * - error / 연결 제거됨 / 재시작 복원 탭: danger 배너 + 이유 + 재연결 버튼
 *
 * alias 는 연결이 store 에서 지워진 뒤에도 connection_id 에서 꺼낼 수 있다
 * (`<alias>:<uuid>`). 예전엔 패널마다 ref 로 기억해서, 다른 호스트의 탭으로 바꿔도
 * 앞 탭의 alias 로 재연결하는 버그가 있었다.
 */
/**
 * 백엔드 자동 재연결 포기 사유(`connection_supervisor.rs` 의 고정 문구) → i18n 키.
 * 모르는 사유(네트워크 오류 원문 등)는 그대로 보인다.
 */
const SUPERVISOR_REASONS: Record<string, string> = {
  "auth failed on reconnect": "banner.reason.authFailed",
  "host alias removed from ~/.ssh/config": "banner.reason.aliasRemoved",
  "automatic reconnect is not supported for directly entered hosts — press Reconnect":
    "banner.reason.adhocUnsupported",
  "could not read ~/.ssh/config while reconnecting":
    "banner.reason.configUnreadable",
};

function reasonText(message: string, t: (key: string) => string): string {
  const key = SUPERVISOR_REASONS[message];
  return key ? t(key) : message;
}

export function ConnectionBanner({
  id,
  onReconnect,
}: {
  id: PaneId;
  /** alias 는 알 수 없으면 null — App 이 ad-hoc 다이얼로그로 폴백. */
  onReconnect: (alias: string | null, paneId: PaneId) => void;
}) {
  const { t } = useTranslation();
  const location = usePanes((s) => activeTab(s, id).location);
  const source = location.source;
  const connId = source.kind === "ssh" ? source.connection_id : null;
  const conn = useConnections((s) => (connId ? s.active[connId] : undefined));
  const alias = conn?.alias ?? (connId ? aliasFromConnectionId(connId) : null);
  const reconnecting = useConnections((s) =>
    alias ? alias in s.reconnecting : false,
  );
  // 표시는 탭·소스 칩과 같은 라벨(별명 → alias → user@ip), 재연결 대상은 raw alias.
  const label = useHostLabel(source);

  if (!connId || source.kind !== "ssh") return null;
  const state = conn?.state ?? { kind: "disconnected" as const };
  if (state.kind === "connected") return null;

  if (state.kind === "connecting" || reconnecting) {
    const text = t(
      reconnecting ? "banner.reconnecting" : "banner.autoReconnecting",
      {
        label,
      },
    );
    return (
      <div
        role="status"
        className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-meta text-fg-muted"
      >
        <Loader size={12} className="shrink-0 animate-spin" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={text}>
          {text}
        </span>
        {!reconnecting && (
          // 백엔드 자동 재연결(최대 ~1분 백오프)을 멈춘다 — 끊김 배너로 바뀌고
          // 그 자리에서 다시 연결할 수 있다.
          <button
            type="button"
            onClick={() => void commands.connectionClose(connId)}
            title={t("banner.stopHint")}
            className="ml-auto flex min-h-6 shrink-0 items-center rounded-panel border border-border bg-base px-2 py-0.5 text-meta text-fg hover:bg-subtle"
          >
            {t("banner.stop")}
          </button>
        )}
      </div>
    );
  }

  const restored = isRestoredRemote(location);
  const headline =
    state.kind === "error"
      ? t("banner.connectionLost")
      : restored
        ? t("banner.notConnected")
        : t("banner.disconnected");
  const reason =
    state.kind === "error"
      ? reasonText(state.message, t)
      : restored
        ? t("banner.restoredReason")
        : t("banner.closedReason");

  return (
    <div
      role="alert"
      className="flex min-h-7 shrink-0 items-center gap-2 border-b border-danger/40 bg-danger/10 px-2 py-1 text-meta"
    >
      <Unplug size={12} className="shrink-0 text-danger" aria-hidden />
      <span
        className="min-w-0 flex-1 truncate text-fg"
        title={`${headline} — ${label}\n${reason}`}
      >
        {headline} — {label}
        <span className="text-fg-muted"> · {reason}</span>
      </span>
      <button
        type="button"
        onClick={() => onReconnect(alias, id)}
        className="ml-auto flex min-h-6 shrink-0 items-center gap-1 rounded-panel border border-border bg-base px-2 py-0.5 text-meta hover:bg-subtle"
      >
        <RefreshCw size={11} aria-hidden />
        {t("banner.reconnect")}
      </button>
    </div>
  );
}
