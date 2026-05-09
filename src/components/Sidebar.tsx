import { Folder, Server, Star, Network, Plus } from "lucide-react";
import { useUI } from "@/stores/ui";
import { useConnections, type Host, type ConnectionState } from "@/stores/connections";
import clsx from "clsx";
import type { ReactNode } from "react";

/**
 * 사이드바.
 *
 * - Local: home (MVP-0 placeholder)
 * - Hosts: `~/.ssh/config` 의 호스트 목록 + 연결 상태 점 + ad-hoc + 버튼.
 *   호스트 더블클릭 → ConnectionDialog. + 버튼 → AdHocConnectDialog.
 * - Bookmarks: MVP-6 placeholder.
 */
export function Sidebar({
  onHostActivate,
  onAdHocOpen,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
}) {
  const open = useUI((s) => s.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-48 flex-col border-r border-border bg-subtle text-base">
      <Section title="Local" icon={<Folder size={14} />}>
        <Item label="Home" />
      </Section>
      <HostsSection onHostActivate={onHostActivate} onAdHocOpen={onAdHocOpen} />
      <Section title="Bookmarks" icon={<Star size={14} />}>
        <Item label="(MVP-6)" muted />
      </Section>
    </aside>
  );
}

function HostsSection({
  onHostActivate,
  onAdHocOpen,
}: {
  onHostActivate: (alias: string) => void;
  onAdHocOpen: () => void;
}) {
  const hosts = useConnections((s) => s.hosts);
  const stateByAlias = useConnections((s) => s.stateByAlias)();

  return (
    <SectionWithAction
      title="Hosts"
      icon={<Server size={14} />}
      action={
        <button
          type="button"
          onClick={onAdHocOpen}
          className="rounded p-0.5 text-fg-muted hover:bg-border hover:text-fg"
          aria-label="Connect to host…"
          title="Connect to host…"
        >
          <Plus size={11} />
        </button>
      }
    >
      {hosts.length === 0 ? (
        <Item label="(no hosts in ~/.ssh/config)" muted />
      ) : (
        hosts.map((h) => (
          <HostItem
            key={h.alias}
            host={h}
            state={stateByAlias[h.alias] ?? { kind: "disconnected" }}
            onActivate={() => onHostActivate(h.alias)}
          />
        ))
      )}
    </SectionWithAction>
  );
}

function HostItem({
  host,
  state,
  onActivate,
}: {
  host: Host;
  state: ConnectionState;
  onActivate: () => void;
}) {
  return (
    <div
      onDoubleClick={onActivate}
      title={`${host.user}@${host.hostname}:${host.port}${host.has_proxy_jump ? " (via jump)" : ""}`}
      className="flex cursor-default items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
    >
      <StateDot state={state} />
      <span className="truncate">{host.alias}</span>
      {host.has_proxy_jump && (
        <Network size={11} className="ml-auto shrink-0 text-fg-muted" aria-label="ProxyJump" />
      )}
    </div>
  );
}

function StateDot({ state }: { state: ConnectionState }) {
  const cls = {
    connected: "bg-green-500",
    connecting: "bg-yellow-500 animate-pulse",
    error: "bg-red-500",
    disconnected: "bg-fg-muted/30",
  }[state.kind];
  const label = state.kind === "error" ? state.message : state.kind;
  return <span aria-label={label} className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", cls)} />;
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center gap-1 text-meta text-fg-muted">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function SectionWithAction({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon: ReactNode;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-border px-2 py-1">
      <div className="flex items-center justify-between gap-1 text-meta text-fg-muted">
        <div className="flex items-center gap-1">
          {icon}
          <span>{title}</span>
        </div>
        {action}
      </div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Item({ label, muted }: { label: string; muted?: boolean }) {
  return (
    <div className={clsx("rounded px-2 py-0.5 hover:bg-border", muted && "text-fg-muted")}>
      {label}
    </div>
  );
}
