import { useRef } from "react";
import { Loader, Unplug, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { usePanes, activeTab, type PaneId } from "@/stores/panes";
import { useConnections } from "@/stores/connections";

/**
 * SSH 패널 연결 상태 배너 — 끊긴 연결을 사이드바 점 색이 아니라 패널 안에서
 * 직접 알리고, 그 자리에서 재연결하게 한다.
 *
 * - connected: 렌더 안 함 (평상시 무소음)
 * - connecting: 스피너 안내
 * - error / 연결 제거됨: danger 배너 + Reconnect 버튼
 *
 * alias 는 연결이 store 에서 제거된 뒤에도 재연결에 필요하므로 ref 로 기억.
 */
export function ConnectionBanner({
  id,
  onReconnect,
}: {
  id: PaneId;
  /** alias 는 알 수 없으면 null — App 이 ad-hoc 다이얼로그로 폴백. */
  onReconnect: (alias: string | null, paneId: PaneId) => void;
}) {
  const source = usePanes((s) => activeTab(s, id).location.source);
  const connId = source.kind === "ssh" ? source.connection_id : null;
  const conn = useConnections((s) => (connId ? s.active[connId] : undefined));
  const lastAlias = useRef<string | null>(null);
  if (conn) lastAlias.current = conn.alias;

  if (!connId || source.kind !== "ssh") return null;
  const state = conn?.state ?? { kind: "disconnected" as const };
  if (state.kind === "connected") return null;

  const label = lastAlias.current ?? `${source.user}@${source.host_ip}`;

  if (state.kind === "connecting") {
    return (
      <div
        role="status"
        className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-subtle px-2 text-meta text-fg-muted"
      >
        <Loader size={12} className="animate-spin" aria-hidden />
        <span className="truncate">Connecting to {label}…</span>
      </div>
    );
  }

  const message = state.kind === "error" ? state.message : "Connection closed";

  return (
    <div
      role="alert"
      className={clsx(
        "flex h-7 shrink-0 items-center gap-2 border-b border-danger/40 bg-danger/10 px-2 text-meta",
      )}
    >
      <Unplug size={12} className="shrink-0 text-danger" aria-hidden />
      <span className="min-w-0 truncate text-fg" title={message}>
        {state.kind === "error" ? "Connection lost" : "Disconnected"} — {label}
      </span>
      <button
        type="button"
        onClick={() => onReconnect(lastAlias.current, id)}
        className="ml-auto flex shrink-0 items-center gap-1 rounded-panel border border-border bg-base px-2 py-0.5 text-meta hover:bg-subtle"
      >
        <RefreshCw size={11} aria-hidden />
        Reconnect
      </button>
    </div>
  );
}
