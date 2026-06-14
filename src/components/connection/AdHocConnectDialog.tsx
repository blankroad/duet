import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Lock, Unlock, X } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ConnectionDto, DuetError, HostKeyInfo, SavedHost } from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { saveHost } from "@/stores/savedHosts";
import { useVault, vaultGet, vaultSet } from "@/stores/vault";
import type { PaneId } from "@/stores/panes";
import { formatErr } from "@/lib/error";
import { MasterPasswordDialog } from "@/components/dialogs/MasterPasswordDialog";
import { HostKeyPrompt } from "./HostKeyPrompt";

/**
 * `~/.ssh/config` 에 없는 host 에 직접 입력으로 연결.
 *
 * **CLAUDE.md §5 (2026-05 완화)**: 비밀번호 input 은 local state 에만, command
 * 호출 직후 clear. store/localStorage 저장 금지. backend 도 메모리에만 사용 후
 * drop, 로그 X.
 *
 * `prefill` 가 주어지면 Saved hosts 에서 더블클릭한 host 의 정보로 입력 채워서 연다.
 */
export interface AdHocConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onConnected: (pane: PaneId, dto: ConnectionDto) => void;
  prefill?: SavedHost | null;
}

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "error"; error: DuetError }
  | { kind: "host-key"; info: HostKeyInfo };

export function AdHocConnectDialog({
  open,
  onClose,
  onConnected,
  prefill,
}: AdHocConnectDialogProps) {
  const upsertActive = useConnections((s) => s.upsertActive);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [password, setPassword] = useState("");
  const [target, setTarget] = useState<PaneId>("left");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [save, setSave] = useState(false);
  const [savePassword, setSavePassword] = useState(false);
  const [alias, setAlias] = useState("");

  // master-pw dialog 상태. mode === "post-unlock" 시 unlock 후 자동 fetch.
  const [masterDialog, setMasterDialog] = useState<
    | { open: false }
    | { open: true; mode: "create" | "unlock"; after: "fetch" | "save" }
  >({ open: false });

  const vault = useVault();
  /** master unlock 후 자동 실행할 작업 (vault_set 등). */
  const saveAfterUnlock = useRef<(() => Promise<void>) | null>(null);

  // 다이얼로그가 열릴 때 prefill 적용 (한 번만 — open false→true edge).
  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setHost(prefill.host);
      setPort(String(prefill.port));
      setUser(prefill.user);
      setKeyPath(prefill.key_path ?? "");
      setAlias(prefill.alias);
      setSave(false); // 이미 저장된 호스트 — 재저장 default off
      setSavePassword(false);
      // vault 가 unlocked 면 저장된 password 가져와서 prefill.
      if (vault.unlocked) {
        void vaultGet(prefill.alias).then((pw) => {
          if (pw) setPassword(pw);
        });
      }
    }
  }, [open, prefill, vault.unlocked]);

  const reset = () => {
    setHost("");
    setPort("22");
    setUser("");
    setKeyPath("");
    setPassword(""); // CLAUDE.md §5: clear from memory after submit
    setTarget("left");
    setPhase({ kind: "idle" });
    setSave(false);
    setSavePassword(false);
    setAlias("");
    setMasterDialog({ open: false });
  };

  /** 저장된 password 를 vault 에서 가져와서 password input 에 채움. vault unlocked 가정. */
  const fetchSavedPassword = async () => {
    if (!prefill) return;
    const pw = await vaultGet(prefill.alias);
    if (pw) setPassword(pw);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  /** Master unlock 성공 후 호출됨 — saveAfterUnlock 콜백 실행. */
  const handleMasterUnlocked = async () => {
    if (saveAfterUnlock.current) {
      const cb = saveAfterUnlock.current;
      saveAfterUnlock.current = null;
      await cb();
    }
    // save 흐름이었으면 AdHoc 자체도 닫기 (connect 완료 후 보류된 상태).
    if (masterDialog.open && masterDialog.after === "save") {
      reset();
      onClose();
    }
  };

  // trust=true 면 미지의 호스트키를 known_hosts 에 기록(사용자가 prompt 에서 신뢰).
  const doConnect = async (trust: boolean) => {
    const portNum = Number.parseInt(port, 10);
    if (!host.trim() || !user.trim() || Number.isNaN(portNum)) {
      setPhase({
        kind: "error",
        error: { kind: "Io", message: "host/port/user required" } as DuetError,
      });
      return;
    }
    setPhase({ kind: "connecting" });
    // password 는 호출 인자로만 전달, store/localStorage 에 저장 안 함 (CLAUDE.md §5).
    const pw = password ? password : null;
    const r = await commands.connectionOpenAdhoc(
      host.trim(),
      portNum,
      user.trim(),
      keyPath.trim() ? keyPath.trim() : null,
      pw,
      trust,
    );
    if (r.status !== "ok") {
      if (r.error.kind === "HostKeyUnverified") {
        // 호스트키 검증 실패 — password 는 신뢰 재시도 위해 유지(component-local, §5).
        setPhase({ kind: "host-key", info: r.error.message });
        return;
      }
      setPassword("");
      setPhase({ kind: "error", error: r.error });
      return;
    }
    setPassword(""); // 성공 — 즉시 clear (저장 흐름은 위에서 캡처한 pw 사용)
    {
      const dto = r.data;
      upsertActive({
        id: dto.id,
        alias: dto.alias,
        host_ip: dto.host_ip,
        user: dto.user,
        state: { kind: "connected" },
      });
      // Save host (CLAUDE.md §5 — password 는 vault 에 별도 저장).
      let needsMasterFlow = false;
      if (save) {
        const savedAlias = alias.trim() || dto.alias;
        await saveHost({
          alias: savedAlias,
          host: host.trim(),
          port: portNum,
          user: user.trim(),
          key_path: keyPath.trim() ? keyPath.trim() : null,
        });
        // password 도 저장 옵션 — vault 에 암호화 저장.
        if (savePassword && pw) {
          if (!vault.unlocked) {
            // master prompt 후 vault_set 호출. saveAfterUnlock callback
            // 으로 연결, vault unlocked 되면 자동 실행.
            const pwToSave = pw;
            saveAfterUnlock.current = async () => {
              await vaultSet(savedAlias, pwToSave);
            };
            setMasterDialog({
              open: true,
              mode: vault.exists ? "unlock" : "create",
              after: "save",
            });
            needsMasterFlow = true;
          } else {
            await vaultSet(savedAlias, pw);
          }
        }
      }
      onConnected(target, dto);
      // master dialog 가 떠있으면 reset/close 는 unlock 끝난 후 (handleMasterUnlocked).
      if (!needsMasterFlow) {
        reset();
        onClose();
      }
    }
  };
  const handleConnect = () => void doConnect(false);

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
              placeholder="~/.ssh/id_ed25519 (optional)"
              className="rounded border border-border bg-subtle px-2 py-1 font-mono focus:border-accent focus:outline-none"
            />
            <label htmlFor="adhoc-pw" className="self-center text-fg-muted">
              Password
            </label>
            <input
              id="adhoc-pw"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="(optional — 키/agent 실패 시 fallback)"
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

          {/* Saved password 가 vault 에 있고 vault 잠겨있으면 unlock 안내. */}
          {prefill && vault.exists && !vault.unlocked && (
            <button
              type="button"
              onClick={() => {
                saveAfterUnlock.current = async () => {
                  await fetchSavedPassword();
                };
                setMasterDialog({ open: true, mode: "unlock", after: "fetch" });
              }}
              className="mt-2 flex w-full items-center justify-center gap-1 rounded border border-border px-2 py-1 text-meta text-fg-muted hover:bg-subtle hover:text-fg"
            >
              <Lock size={11} />
              Unlock vault to autofill saved password
            </button>
          )}
          {prefill && vault.unlocked && (
            <div className="mt-2 flex items-center gap-1 text-meta text-fg-muted">
              <Unlock size={11} />
              Vault unlocked — saved password (if any) loaded
            </div>
          )}

          <div className="mt-3">
            <label className="flex cursor-pointer items-center gap-2 text-base">
              <input
                type="checkbox"
                checked={save}
                onChange={(e) => setSave(e.target.checked)}
              />
              <span>Save host</span>
            </label>
            {save && (
              <div className="mt-2 space-y-2">
                <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-base">
                  <label htmlFor="adhoc-alias" className="self-center text-fg-muted">
                    Alias
                  </label>
                  <input
                    id="adhoc-alias"
                    type="text"
                    value={alias}
                    onChange={(e) => setAlias(e.target.value)}
                    placeholder={`${user.trim() || "user"}@${host.trim() || "host"}:${port}`}
                    className="rounded border border-border bg-subtle px-2 py-1 font-mono focus:border-accent focus:outline-none"
                  />
                </div>
                {password.length > 0 && (
                  <label className="flex cursor-pointer items-center gap-2 pl-2 text-base">
                    <input
                      type="checkbox"
                      checked={savePassword}
                      onChange={(e) => setSavePassword(e.target.checked)}
                    />
                    <Lock size={11} className="text-fg-muted" />
                    <span>
                      Save password too (encrypted with master — age scrypt+ChaCha20)
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>

          {phase.kind === "error" && (
            <div className="mt-3 rounded border border-danger/50 bg-danger/10 p-2 text-meta">
              <div className="font-medium text-danger">{phase.error.kind}</div>
              <div className="text-fg-muted">{formatErr(phase.error)}</div>
              {phase.error.kind === "AuthFailed" && (
                <div className="mt-1 text-fg-muted">
                  키/agent 실패. password 입력 후 다시 시도하거나 키파일 경로 확인.
                </div>
              )}
            </div>
          )}
          {phase.kind === "host-key" && (
            <HostKeyPrompt
              info={phase.info}
              onTrust={() => void doConnect(true)}
              onCancel={handleClose}
            />
          )}

          {phase.kind !== "host-key" && (
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
          )}

          <Dialog.Description className="sr-only">
            Connect to a host that is not in your ~/.ssh/config.
          </Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>

      {masterDialog.open && (
        <MasterPasswordDialog
          open
          mode={masterDialog.mode}
          onClose={() => setMasterDialog({ open: false })}
          onUnlocked={handleMasterUnlocked}
        />
      )}
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
