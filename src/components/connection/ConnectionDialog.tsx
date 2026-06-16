import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Network, X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ConnectionDto, DuetError, HostKeyInfo } from "@/types/bindings";
import { useConnections, type Host } from "@/stores/connections";
import type { PaneId } from "@/stores/panes";
import { HostKeyPrompt } from "./HostKeyPrompt";

/**
 * 새 SSH 연결 다이얼로그.
 *
 * 호스트 더블클릭 → `alias` 가 들어오면 열림. 사용자가 패널 선택 + Connect →
 * `commands.connectionOpen` → 성공 시 connections store 갱신 + onConnected
 * 콜백 (App 이 해당 패널을 SSH 로 navigate).
 *
 * **CLAUDE.md §5 (2026-05 완화)**: 비밀번호 input 은 local state 에만,
 * command 호출 직후 clear. store/localStorage 저장 금지.
 */
export interface ConnectionDialogProps {
  /** 열려있는 호스트 alias (null 이면 닫힘). */
  alias: string | null;
  onClose: () => void;
  /** 연결 성공 시 호출 — App 이 이 pane 의 location 을 SSH 로 navigate. */
  onConnected: (pane: PaneId, dto: ConnectionDto) => void;
}

type DialogPhase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "error"; error: DuetError }
  | { kind: "host-key"; info: HostKeyInfo };

export function ConnectionDialog({ alias, onClose, onConnected }: ConnectionDialogProps) {
  const hosts = useConnections((s) => s.hosts);
  const upsertActive = useConnections((s) => s.upsertActive);

  const host = alias ? hosts.find((h) => h.alias === alias) : undefined;
  const open = host !== undefined;

  const [target, setTarget] = useState<PaneId>("left");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<DialogPhase>({ kind: "idle" });

  // 다이얼로그가 새 호스트로 다시 열릴 때마다 phase + password 초기화.
  useEffect(() => {
    if (open) {
      setPhase({ kind: "idle" });
      setPassword("");
    }
  }, [open, alias]);

  // trust=true 면 미지의 호스트키를 known_hosts 에 기록(TOFU). replaceChanged=true 면
  // *변경된* 키를 백업 후 교체(사용자가 새 fingerprint 검증 후 prompt 에서 명시 승인).
  const doConnect = async (trust: boolean, replaceChanged = false) => {
    if (!host) return;
    setPhase({ kind: "connecting" });
    const pw = password ? password : null;
    const result = await commands.connectionOpen(host.alias, pw, trust, replaceChanged);
    if (result.status === "ok") {
      setPassword(""); // 성공 — 즉시 clear (CLAUDE.md §5)
      const dto = result.data;
      upsertActive({
        id: dto.id,
        alias: dto.alias,
        host_ip: dto.host_ip,
        user: dto.user,
        state: { kind: "connected" },
      });
      onConnected(target, dto);
      onClose();
      return;
    }
    if (result.error.kind === "HostKeyUnverified") {
      // 호스트키 검증 단계(인증 前) 실패 — password 는 신뢰 재시도 위해 유지
      // (component-local state 한정, §5). prompt 에서 신뢰하면 doConnect(true) 재호출.
      setPhase({ kind: "host-key", info: result.error.message });
      return;
    }
    setPassword(""); // 그 외 실패 — clear
    setPhase({ kind: "error", error: result.error });
  };
  const handleConnect = () => void doConnect(false);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="text-title font-medium">Connect to {alias}</Dialog.Title>
            <Dialog.Close
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Close"
            >
              <X size={14} />
            </Dialog.Close>
          </div>

          {host && <HostInfo host={host} />}

          <div className="mt-4">
            <div className="text-meta text-fg-muted">Open in pane</div>
            <div className="mt-1 flex gap-2">
              <PaneRadio value="left" current={target} onChange={setTarget} label="Left" />
              <PaneRadio value="right" current={target} onChange={setTarget} label="Right" />
            </div>
          </div>

          <div className="mt-3">
            <label htmlFor="conn-pw" className="block text-meta text-fg-muted">
              Password (optional — fallback if key/agent fails)
            </label>
            <input
              id="conn-pw"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-subtle px-2 py-1 font-mono text-base focus:border-accent focus:outline-none"
            />
          </div>

          {phase.kind === "error" && <ErrorBox error={phase.error} />}
          {phase.kind === "host-key" && (
            <HostKeyPrompt
              info={phase.info}
              onTrust={() => void doConnect(true)}
              onReplace={() => void doConnect(false, true)}
              onCancel={onClose}
            />
          )}

          {phase.kind !== "host-key" && (
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
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
          )}

          <Dialog.Description className="sr-only">
            Open a new SSH connection to {alias} and attach it to a pane.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HostInfo({ host }: { host: Host }) {
  return (
    <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-base">
      <dt className="text-fg-muted">Host</dt>
      <dd className="font-mono">
        {host.user}@{host.hostname}:{host.port}
      </dd>
      {host.has_proxy_jump && (
        <>
          <dt className="text-fg-muted">Proxy</dt>
          <dd className="flex items-center gap-1 text-fg-muted">
            <Network size={12} /> via jump host (1-hop)
          </dd>
        </>
      )}
    </dl>
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

function ErrorBox({ error }: { error: DuetError }) {
  const message = formatError(error);
  const isAuth = error.kind === "AuthFailed";
  return (
    <div className="mt-3 rounded border border-danger/50 bg-danger/10 p-2 text-meta">
      <div className="font-medium text-danger">{error.kind}</div>
      <div className="text-fg-muted">{message}</div>
      {isAuth && (
        <div className="mt-1 text-fg-muted">
          Key/agent + (if entered) password all failed. Check the password and retry.
        </div>
      )}
    </div>
  );
}

function formatError(error: DuetError): string {
  return "message" in error && typeof error.message === "string" ? error.message : error.kind;
}
