import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Network, Server } from "lucide-react";
import { commands } from "@/types/bindings";
import type { ConnectionDto, DuetError, HostKeyInfo } from "@/types/bindings";
import { useConnections, type Host } from "@/stores/connections";
import type { PaneId } from "@/stores/panes";
import { HostKeyPrompt } from "./HostKeyPrompt";
import { DialogShell } from "@/components/dialogs/DialogShell";
import { DialogButton } from "@/components/dialogs/DialogButton";
import { DialogInput } from "@/components/dialogs/DialogInput";
import { formatErr } from "@/lib/error";
import { ConnectErrorBox } from "./ConnectErrorBox";

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

export function ConnectionDialog({
  alias,
  onClose,
  onConnected,
}: ConnectionDialogProps) {
  const { t } = useTranslation();
  const hosts = useConnections((s) => s.hosts);
  const upsertActive = useConnections((s) => s.upsertActive);

  const host = alias ? hosts.find((h) => h.alias === alias) : undefined;
  const open = host !== undefined;

  const [target, setTarget] = useState<PaneId>("left");
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState<DialogPhase>({ kind: "idle" });
  const pwRef = useRef<HTMLInputElement>(null);
  // 연결 시도 세대 — 연결 중에 닫으면 늦게 온 결과로 패널을 옮기지 않는다.
  const attempt = useRef(0);

  // 다이얼로그가 새 호스트로 다시 열릴 때마다 phase + password 초기화.
  useEffect(() => {
    if (open) {
      attempt.current += 1;
      setPhase({ kind: "idle" });
      setPassword("");
    }
  }, [open, alias]);

  const close = () => {
    attempt.current += 1;
    setPassword("");
    onClose();
  };

  // trust=true 면 미지의 호스트키를 known_hosts 에 기록(TOFU). replaceChanged=true 면
  // *변경된* 키를 백업 후 교체(사용자가 새 fingerprint 검증 후 prompt 에서 명시 승인).
  const doConnect = async (trust: boolean, replaceChanged = false) => {
    if (!host) return;
    setPhase({ kind: "connecting" });
    const pw = password ? password : null;
    const mine = ++attempt.current;
    let result: Awaited<ReturnType<typeof commands.connectionOpen>>;
    try {
      result = await commands.connectionOpen(
        host.alias,
        pw,
        trust,
        replaceChanged,
      );
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
      if (result.status === "ok") void commands.connectionClose(result.data.id);
      return;
    }
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
      close();
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

  const busy = phase.kind === "connecting";
  return (
    <DialogShell
      open={open}
      title={t("dialog.connection.title", { alias })}
      description={t("dialog.connection.desc", { alias })}
      icon={Server}
      onClose={close}
      initialFocus={pwRef}
      footer={
        phase.kind === "host-key" ? undefined : (
          <>
            <DialogButton hint="esc" onClick={close}>
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
      {host && <HostInfo host={host} />}

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

      <div>
        <label htmlFor="conn-pw" className="block text-meta text-fg-muted">
          {t("dialog.connection.passwordLabel")}
        </label>
        <DialogInput
          ref={pwRef}
          id="conn-pw"
          mono
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) handleConnect();
          }}
          className="mt-1"
        />
      </div>

      {phase.kind === "error" && (
        <ConnectErrorBox
          error={phase.error}
          authHint={t("dialog.connection.authFailedHint")}
        />
      )}
      {phase.kind === "host-key" && (
        <HostKeyPrompt
          info={phase.info}
          onTrust={() => void doConnect(true)}
          onReplace={() => void doConnect(false, true)}
          onCancel={close}
        />
      )}
    </DialogShell>
  );
}

function HostInfo({ host }: { host: Host }) {
  const { t } = useTranslation();
  return (
    <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-base">
      <dt className="text-fg-muted">{t("dialog.connection.host")}</dt>
      <dd className="font-mono">
        {host.user}@{host.hostname}:{host.port}
      </dd>
      {host.has_proxy_jump && (
        <>
          <dt className="text-fg-muted">{t("dialog.connection.proxy")}</dt>
          <dd className="flex items-center gap-1 text-fg-muted">
            <Network size={12} /> {t("dialog.connection.viaJump")}
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
