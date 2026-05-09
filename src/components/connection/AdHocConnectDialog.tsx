import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ConnectionId, DuetError } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import type { PaneId } from "@/stores/panes";
import { formatErr } from "@/lib/error";

/**
 * `~/.ssh/config` 에 없는 host 에 직접 입력으로 연결.
 *
 * **CLAUDE.md §5**: 비밀번호 IPC 송신 금지 — 키파일 경로 또는 SSH agent 만.
 * 비밀번호 인증은 MVP-1 Task 7b (secure prompt) 완성 후 추가.
 */
export interface AdHocConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onConnected: (pane: PaneId, connectionId: ConnectionId, alias: string) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "error"; error: DuetError };

export function AdHocConnectDialog({ open, onClose, onConnected }: AdHocConnectDialogProps) {
  const upsertActive = useConnections((s) => s.upsertActive);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [target, setTarget] = useState<PaneId>("left");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const reset = () => {
    setHost("");
    setPort("22");
    setUser("");
    setKeyPath("");
    setTarget("left");
    setPhase({ kind: "idle" });
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleConnect = async () => {
    const portNum = Number.parseInt(port, 10);
    if (!host.trim() || !user.trim() || Number.isNaN(portNum)) {
      setPhase({
        kind: "error",
        error: { kind: "Io", message: "host/port/user required" } as DuetError,
      });
      return;
    }
    setPhase({ kind: "connecting" });
    const r = await commands.connectionOpenAdhoc(
      host.trim(),
      portNum,
      user.trim(),
      keyPath.trim() ? keyPath.trim() : null,
    );
    if (r.status === "ok") {
      const id: ConnectionId = r.data;
      const alias = `${user.trim()}@${host.trim()}:${portNum}`;
      upsertActive({
        id,
        alias,
        host_ip: "",
        user: user.trim(),
        state: { kind: "connected" },
      });
      onConnected(target, id, alias);
      reset();
      onClose();
    } else {
      setPhase({ kind: "error", error: r.error });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none">
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="text-title font-medium">Connect to host…</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-base">
            <label htmlFor="adhoc-host" className="self-center text-fg-muted">
              Host
            </label>
            <input
              id="adhoc-host"
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.0.2 or example.com"
              autoFocus
              className="rounded border border-border bg-subtle px-2 py-1 font-mono focus:border-accent focus:outline-none"
            />
            <label htmlFor="adhoc-port" className="self-center text-fg-muted">
              Port
            </label>
            <input
              id="adhoc-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className="rounded border border-border bg-subtle px-2 py-1 font-mono focus:border-accent focus:outline-none"
            />
            <label htmlFor="adhoc-user" className="self-center text-fg-muted">
              User
            </label>
            <input
              id="adhoc-user"
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root"
              className="rounded border border-border bg-subtle px-2 py-1 font-mono focus:border-accent focus:outline-none"
            />
            <label htmlFor="adhoc-key" className="self-center text-fg-muted">
              Key
            </label>
            <input
              id="adhoc-key"
              type="text"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_ed25519 (optional — agent 만 쓰면 비워둠)"
              className="rounded border border-border bg-subtle px-2 py-1 font-mono focus:border-accent focus:outline-none"
            />
          </div>

          <div className="mt-4">
            <div className="text-meta text-fg-muted">Open in pane</div>
            <div className="mt-1 flex gap-2">
              <PaneRadio value="left" current={target} onChange={setTarget} label="Left" />
              <PaneRadio value="right" current={target} onChange={setTarget} label="Right" />
            </div>
          </div>

          {phase.kind === "error" && (
            <div className="mt-3 rounded border border-danger/50 bg-danger/10 p-2 text-meta">
              <div className="font-medium text-danger">{phase.error.kind}</div>
              <div className="text-fg-muted">{formatErr(phase.error)}</div>
              {phase.error.kind === "AuthFailed" && (
                <div className="mt-1 text-fg-muted">
                  Password 인증은 MVP-1 Task 7b 까지 미지원 — 키 또는 agent 필요.
                </div>
              )}
            </div>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={handleClose}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConnect}
              disabled={phase.kind === "connecting"}
              className="rounded bg-accent px-3 py-1 text-base text-white disabled:opacity-50"
            >
              {phase.kind === "connecting" ? "Connecting…" : "Connect"}
            </button>
          </div>

          <Dialog.Description className="sr-only">
            Connect to a host that is not in your ~/.ssh/config.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaneRadio({
  value,
  current,
  onChange,
  label,
}: {
  value: PaneId;
  current: PaneId;
  onChange: (v: PaneId) => void;
  label: string;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={
        "flex-1 rounded border px-2 py-1 text-base " +
        (selected
          ? "border-accent bg-active"
          : "border-border text-fg-muted hover:bg-subtle")
      }
    >
      {label}
    </button>
  );
}
