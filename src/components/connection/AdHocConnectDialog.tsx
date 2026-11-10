import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, RefreshCw, Server, Unlock } from "lucide-react";
import { commands } from "@/types/bindings";
import type {
  ConnectionDto,
  DuetError,
  HostKeyInfo,
  SavedHost,
} from "@/types/bindings";
import { useConnections } from "@/stores/connections";
import { saveHost } from "@/stores/savedHosts";
import { useVault, vaultHas, vaultSet } from "@/stores/vault";
import type { PaneId } from "@/stores/panes";
import { MasterPasswordDialog } from "@/components/dialogs/MasterPasswordDialog";
import { HostKeyPrompt } from "./HostKeyPrompt";
import { DialogShell } from "@/components/dialogs/DialogShell";
import { DialogButton } from "@/components/dialogs/DialogButton";
import { DialogInput } from "@/components/dialogs/DialogInput";
import { ConnectErrorBox } from "./ConnectErrorBox";
import { ReconnectTarget, type ReconnectInfo } from "./ReconnectTarget";
import { formatErr } from "@/lib/error";
import { showError } from "@/lib/errorToast";

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
  /** 처음 선택돼 있을 패널 — 보통 지금 활성 패널. */
  defaultPane?: PaneId | undefined;
  /** 배너 "재연결" 로 열린 경우 — 패널을 묻지 않고 자동 재연결 실패 이유를 보여 준다. */
  reconnect?: ReconnectInfo | null | undefined;
}

/** 한 번의 ad-hoc 연결 요청이 겨누는 곳 (비밀번호 제외). */
interface AdhocTarget {
  host: string;
  port: number;
  user: string;
  keyPath: string | null;
  savedPasswordAlias: string | null;
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
  defaultPane,
  reconnect,
}: AdHocConnectDialogProps) {
  const { t } = useTranslation();
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
  // 저장된 비밀번호 존재 여부(평문 아님, §5 2026-07) — 접속 시 backend 가 vault 에서
  // 직접 꺼내 쓴다. 여기선 UI 힌트/전달 여부 판단에만 사용.
  const [hasSavedPassword, setHasSavedPassword] = useState(false);

  // master-pw dialog 상태. mode === "post-unlock" 시 unlock 후 자동 fetch.
  const [masterDialog, setMasterDialog] = useState<
    | { open: false }
    | { open: true; mode: "create" | "unlock"; after: "fetch" | "save" }
  >({ open: false });

  const vault = useVault();
  /** master unlock 후 자동 실행할 작업 (vault_set 등). */
  const saveAfterUnlock = useRef<(() => Promise<void>) | null>(null);
  // 연결 시도 세대 — 연결 중에 닫으면 늦게 온 결과로 패널을 옮기지 않는다.
  const attempt = useRef(0);
  // 호스트 키 확인 뒤 재시도용 비밀번호 — 입력칸은 호출 직후 비우고(§5), 신뢰 후
  // 같은 비번으로 다시 붙을 때만 여기서 꺼낸다. 닫거나 재시도하면 버린다.
  const retryPw = useRef<string | null>(null);
  // 호스트 키 프롬프트를 띄운 요청의 주소 — [신뢰]/[교체] 는 폼이 아니라 이 값으로
  // 재시도한다(프롬프트가 보여 준 호스트와 실제 신뢰 대상이 어긋나지 않게).
  const hostKeyReq = useRef<AdhocTarget | null>(null);

  // 열릴 때마다(open false→true) 패널과 첫 안내를 정한다.
  useEffect(() => {
    if (!open) return;
    setTarget(reconnect?.pane ?? defaultPane ?? "left");
    const e = reconnect?.error;
    setPhase(
      !e
        ? { kind: "idle" }
        : e.kind === "HostKeyUnverified"
          ? { kind: "host-key", info: e.message }
          : { kind: "error", error: e },
    );
  }, [open, reconnect, defaultPane]);

  // 다이얼로그가 열릴 때 prefill 적용 (한 번만 — open false→true edge).
  // vault 잠금 해제는 여기에 걸지 않는다 — 예전엔 해제할 때마다 폼이 저장값으로 다시
  // 채워져, 호스트 키 확인 중 고친 주소가 몰래 되돌아갔다.
  useEffect(() => {
    if (!open || !prefill) return;
    setHost(prefill.host);
    setPort(String(prefill.port));
    setUser(prefill.user);
    setKeyPath(prefill.key_path ?? "");
    setAlias(prefill.alias);
    setSave(false); // 이미 저장된 호스트 — 재저장 default off
    setSavePassword(false);
  }, [open, prefill]);

  // vault 가 unlocked 면 저장된 password '존재 여부'만 확인(평문 안 가져옴, §5) — 힌트용.
  useEffect(() => {
    if (!open || !prefill || !vault.unlocked) return;
    void vaultHas(prefill.alias).then(setHasSavedPassword);
  }, [open, prefill, vault.unlocked]);

  const reset = () => {
    setHost("");
    setPort("22");
    setUser("");
    setKeyPath("");
    setPassword(""); // CLAUDE.md §5: clear from memory after submit
    retryPw.current = null;
    hostKeyReq.current = null;
    saveAfterUnlock.current = null; // 평문을 캡처한 저장 콜백도 버린다
    setTarget("left");
    setPhase({ kind: "idle" });
    setSave(false);
    setSavePassword(false);
    setAlias("");
    setHasSavedPassword(false);
    setMasterDialog({ open: false });
  };

  /** 입력한 주소가 프리필한 저장 호스트와 같은가 — 저장된 비번은 이때만 쓴다. */
  const savedEndpoint =
    prefill !== null &&
    prefill !== undefined &&
    host.trim() === prefill.host &&
    user.trim() === prefill.user &&
    Number.parseInt(port, 10) === prefill.port;

  /** unlock 후 저장된 password '존재 여부' 재확인(평문 안 가져옴, §5). */
  const refreshHasSavedPassword = async () => {
    if (!prefill) return;
    setHasSavedPassword(await vaultHas(prefill.alias));
  };

  const handleClose = () => {
    attempt.current += 1;
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

  // trust=true 면 미지의 호스트키를 known_hosts 에 기록(TOFU). replaceChanged=true 면
  // *변경된* 키를 백업 후 교체(사용자가 새 fingerprint 검증 후 prompt 에서 명시 승인).
  const doConnect = async (trust: boolean, replaceChanged = false) => {
    // 호스트 키 승인 재시도면 프롬프트를 띄운 요청 그대로, 아니면 지금 폼 값.
    const snap = trust || replaceChanged ? hostKeyReq.current : null;
    hostKeyReq.current = null;
    const portNum = snap ? snap.port : Number.parseInt(port, 10);
    if (!snap && (!host.trim() || !user.trim() || Number.isNaN(portNum))) {
      setPhase({
        kind: "error",
        error: { kind: "Io", message: t("dialog.adhoc.required") } as DuetError,
      });
      return;
    }
    setPhase({ kind: "connecting" });
    // password 는 호출 인자로만 전달, store/localStorage 에 저장 안 함 (CLAUDE.md §5).
    const pw = password || retryPw.current || null;
    retryPw.current = null;
    setPassword(""); // 호출 직후 clear — 저장 흐름은 위에서 캡처한 pw 사용 (§5)
    // 사용자가 비번을 안 쳤으면, 평문을 프론트로 가져오지 않고 alias 만 넘겨 backend 가
    // vault 에서 직접 꺼내 쓰게 한다 (§5 2026-07). 저장된 비번이 없으면 backend 가 None
    // 으로 처리하므로 존재 확인(vaultHas)을 기다리지 않는다 — 빨리 누르면 놓치던 경쟁.
    // 단 **주소가 저장된 그대로일 때만** — 프리필 후 host 를 고쳤는데 옛 호스트의
    // 비번을 새 서버로 보내면 안 된다.
    const req: AdhocTarget = snap ?? {
      host: host.trim(),
      port: portNum,
      user: user.trim(),
      keyPath: keyPath.trim() ? keyPath.trim() : null,
      savedPasswordAlias:
        !pw && savedEndpoint && vault.unlocked && prefill
          ? prefill.alias
          : null,
    };
    const mine = ++attempt.current;
    let r: Awaited<ReturnType<typeof commands.connectionOpenAdhoc>>;
    try {
      r = await commands.connectionOpenAdhoc({
        host: req.host,
        port: req.port,
        user: req.user,
        keyPath: req.keyPath,
        password: pw,
        savedPasswordAlias: req.savedPasswordAlias,
        trustHostKey: trust,
        replaceChangedHostKey: replaceChanged,
      });
    } catch (e) {
      // IPC 자체 실패(reject) — 버튼이 "연결 중…" 에 멈추지 않게 오류로 보인다.
      if (mine !== attempt.current) return;
      setPassword("");
      setPhase({
        kind: "error",
        error: { kind: "ConnectionFailed", message: formatErr(e) },
      });
      return;
    }
    if (mine !== attempt.current) {
      // 사용자가 연결 중에 취소함 — 만들어진 연결은 닫는다(원치 않은 세션 방지).
      setPassword("");
      if (r.status === "ok") void commands.connectionClose(r.data.id);
      return;
    }
    if (r.status !== "ok") {
      if (r.error.kind === "HostKeyUnverified") {
        // 호스트키 검증 실패 — 신뢰 재시도에 쓸 비번만 ref 에 보관(component-local, §5).
        retryPw.current = pw;
        hostKeyReq.current = req;
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
        // 저장 실패는 연결을 되돌리지 않지만 알려야 한다 — 예전엔 조용히 닫혀 다음
        // 접속 때야 호스트·비밀번호가 없는 걸 알았다(remote-NEW-1).
        const hostErr = await saveHost({
          alias: savedAlias,
          host: req.host,
          port: req.port,
          user: req.user,
          key_path: req.keyPath,
        });
        if (hostErr)
          showError("dialog.adhoc.saveHostFailed", hostErr, {
            vars: { alias: savedAlias },
          });
        if (mine !== attempt.current) {
          // 저장하는 사이 취소함 — 늦게 패널을 옮기거나 저장 프롬프트를 띄우지 않는다.
          void commands.connectionClose(dto.id);
          return;
        }
        // password 도 저장 옵션 — vault 에 암호화 저장.
        if (savePassword && pw) {
          if (!vault.unlocked) {
            // master prompt 후 vault_set 호출. saveAfterUnlock callback
            // 으로 연결, vault unlocked 되면 자동 실행.
            const pwToSave = pw;
            saveAfterUnlock.current = async () => {
              const err = await vaultSet(savedAlias, pwToSave);
              if (err)
                showError("dialog.adhoc.savePasswordFailed", err, {
                  vars: { alias: savedAlias },
                });
            };
            setMasterDialog({
              open: true,
              mode: vault.exists ? "unlock" : "create",
              after: "save",
            });
            needsMasterFlow = true;
          } else {
            const pwErr = await vaultSet(savedAlias, pw);
            if (pwErr)
              showError("dialog.adhoc.savePasswordFailed", pwErr, {
                vars: { alias: savedAlias },
              });
            if (mine !== attempt.current) {
              void commands.connectionClose(dto.id);
              return;
            }
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

  const busy = phase.kind === "connecting";
  // 연결 중·호스트 키 확인 중엔 입력을 잠근다 — 프롬프트가 보여 준 호스트가 아닌
  // 다른 주소로 고친 뒤 "신뢰"를 누르면 그 다른 호스트의 키를 학습했다.
  const locked = busy || phase.kind === "host-key";
  return (
    <>
      <DialogShell
        open={open}
        title={
          reconnect && prefill
            ? t("dialog.connection.reconnectTitle", { alias: prefill.alias })
            : t("dialog.adhoc.title")
        }
        description={t("dialog.adhoc.desc")}
        icon={reconnect ? RefreshCw : Server}
        onClose={handleClose}
        // 입력칸에서 Enter = 연결 (버튼에 ↵ 힌트가 있는데 동작하지 않았다).
        onKeyDown={(e) => {
          if (e.key !== "Enter" || e.nativeEvent.isComposing || locked) return;
          const el = e.target;
          if (!(el instanceof HTMLInputElement) || el.type === "checkbox")
            return;
          e.preventDefault();
          handleConnect();
        }}
        footer={
          phase.kind === "host-key" ? undefined : (
            <>
              <DialogButton hint="esc" onClick={handleClose}>
                {t("common.cancel")}
              </DialogButton>
              <DialogButton
                tone="primary"
                hint="enter"
                disabled={busy}
                onClick={handleConnect}
              >
                {busy
                  ? t("dialog.connection.connecting")
                  : t("dialog.connection.connect")}
              </DialogButton>
            </>
          )
        }
      >
        <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-base">
          <label htmlFor="adhoc-host" className="self-center text-fg-muted">
            {t("dialog.adhoc.host")}
          </label>
          <DialogInput
            disabled={locked}
            id="adhoc-host"
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder={t("dialog.adhoc.hostPlaceholder")}
            autoFocus
            mono
          />
          <label htmlFor="adhoc-port" className="self-center text-fg-muted">
            {t("dialog.adhoc.port")}
          </label>
          <DialogInput
            disabled={locked}
            id="adhoc-port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
            mono
          />
          <label htmlFor="adhoc-user" className="self-center text-fg-muted">
            {t("dialog.adhoc.user")}
          </label>
          <DialogInput
            disabled={locked}
            id="adhoc-user"
            type="text"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="root"
            mono
          />
          <label htmlFor="adhoc-key" className="self-center text-fg-muted">
            {t("dialog.adhoc.key")}
          </label>
          <DialogInput
            disabled={locked}
            id="adhoc-key"
            type="text"
            value={keyPath}
            onChange={(e) => setKeyPath(e.target.value)}
            placeholder={t("dialog.adhoc.keyPlaceholder")}
            mono
          />
          <label htmlFor="adhoc-pw" className="self-center text-fg-muted">
            {t("dialog.adhoc.password")}
          </label>
          <DialogInput
            disabled={locked}
            id="adhoc-pw"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              hasSavedPassword && savedEndpoint && !password
                ? t("dialog.adhoc.savedPwAvailable")
                : t("dialog.adhoc.pwPlaceholder")
            }
            mono
          />
        </div>

        {reconnect ? (
          <ReconnectTarget pane={reconnect.pane} />
        ) : (
          <div>
            <div className="text-meta text-fg-muted">
              {t("dialog.connection.openInPane")}
            </div>
            <div className="mt-1 flex gap-2">
              <PaneRadio
                value="left"
                current={target}
                onChange={setTarget}
                label={t("dialog.connection.paneLeft")}
              />
              <PaneRadio
                value="right"
                current={target}
                onChange={setTarget}
                label={t("dialog.connection.paneRight")}
              />
            </div>
          </div>
        )}

        {/* Saved password 가 vault 에 있고 vault 잠겨있으면 unlock 안내. */}
        {prefill && vault.exists && !vault.unlocked && (
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              saveAfterUnlock.current = async () => {
                await refreshHasSavedPassword();
              };
              setMasterDialog({ open: true, mode: "unlock", after: "fetch" });
            }}
            className="flex w-full items-center justify-center gap-1 rounded border border-border px-2 py-1 text-meta text-fg-muted hover:bg-subtle hover:text-fg disabled:opacity-40"
          >
            <Lock size={11} />
            {t("dialog.adhoc.unlockVault")}
          </button>
        )}
        {prefill && vault.unlocked && (
          <div className="flex items-center gap-1 text-meta text-fg-muted">
            <Unlock size={11} />
            {t("dialog.adhoc.vaultUnlocked")}
          </div>
        )}

        <div>
          <label className="flex cursor-pointer items-center gap-2 text-base">
            <input
              type="checkbox"
              checked={save}
              disabled={locked}
              onChange={(e) => setSave(e.target.checked)}
            />
            <span>{t("dialog.adhoc.saveHost")}</span>
          </label>
          {save && (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-base">
                <label
                  htmlFor="adhoc-alias"
                  className="self-center text-fg-muted"
                >
                  {t("dialog.adhoc.alias")}
                </label>
                <DialogInput
                  disabled={locked}
                  id="adhoc-alias"
                  type="text"
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder={`${user.trim() || "user"}@${host.trim() || "host"}:${port}`}
                  mono
                />
              </div>
              {password.length > 0 && (
                <label className="flex cursor-pointer items-center gap-2 pl-2 text-base">
                  <input
                    type="checkbox"
                    checked={savePassword}
                    disabled={locked}
                    onChange={(e) => setSavePassword(e.target.checked)}
                  />
                  <Lock size={11} className="text-fg-muted" />
                  <span>{t("dialog.adhoc.savePassword")}</span>
                </label>
              )}
            </div>
          )}
        </div>

        {phase.kind === "error" && (
          <ConnectErrorBox
            error={phase.error}
            authHint={t("dialog.adhoc.authFailedHint")}
          />
        )}
        {phase.kind === "host-key" && (
          <HostKeyPrompt
            info={phase.info}
            onTrust={() => void doConnect(true)}
            onReplace={() => void doConnect(false, true)}
            onCancel={handleClose}
          />
        )}
      </DialogShell>

      {masterDialog.open && (
        <MasterPasswordDialog
          open
          mode={masterDialog.mode}
          onClose={() => {
            // 마스터 비번을 취소하면 평문을 쥔 저장 콜백도 버린다 (§5).
            saveAfterUnlock.current = null;
            if (masterDialog.after === "save") {
              // 연결·패널 이동은 이미 끝났다 — "연결 중…" 에 멈춘 채 남기지 않는다.
              reset();
              onClose();
              return;
            }
            setMasterDialog({ open: false });
          }}
          onUnlocked={handleMasterUnlocked}
        />
      )}
    </>
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
      aria-pressed={selected}
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
