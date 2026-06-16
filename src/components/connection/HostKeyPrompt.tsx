import { useState } from "react";
import { ShieldQuestion, ShieldAlert } from "lucide-react";
import type { HostKeyInfo } from "@/types/bindings";

/**
 * 서버 호스트키 검증 결과 프롬프트 (OpenSSH 방식).
 *
 * - 미지의 호스트(TOFU): fingerprint 확인 후 "Trust & connect" → known_hosts 기록.
 * - 키 변경(MITM 위험): 기본은 신뢰 불가. 사용자가 새 fingerprint 를 다른 경로로
 *   확인했다고 체크박스로 명시 승인하면 "키 교체 후 연결" 가능 — 백엔드가 기존
 *   known_hosts 줄을 백업 후 제거하고 새 키로 교체한다(원본은 `.duet-bak.<ts>`).
 *
 * 신뢰/교체 결정은 사용자만 — fingerprint 를 보여주고 명시 승인을 받는다 (CLAUDE.md §9).
 */
export function HostKeyPrompt({
  info,
  onTrust,
  onReplace,
  onCancel,
}: {
  info: HostKeyInfo;
  onTrust: () => void;
  onReplace: () => void;
  onCancel: () => void;
}) {
  const [verified, setVerified] = useState(false);
  if (info.changed) {
    return (
      <div className="mt-3 rounded border border-danger/60 bg-danger/10 p-3 text-meta">
        <div className="flex items-center gap-1.5 font-medium text-danger">
          <ShieldAlert size={14} /> Host key changed — connection blocked
        </div>
        <p className="mt-1.5 text-fg">
          <span className="font-mono">{info.host}</span>&apos;s server key differs from the recorded one.
          Could be a server reinstall, but also a <b>man-in-the-middle (MITM) attack</b>.
        </p>
        <KeyRow label="Presented key" value={info.fingerprint} />
        <p className="mt-1.5 text-fg-muted">
          Verify this fingerprint matches a trusted source (server admin/console, etc.){" "}
          <b>through a different channel</b>. Once verified, you can replace the key below — the existing{" "}
          <span className="font-mono">~/.ssh/known_hosts</span>
          {info.changed_line != null && (
            <>
              {" "}
              entry #<span className="font-mono">{info.changed_line}</span>
            </>
          )}{" "}
          will be removed after backup (<span className="font-mono">.duet-bak</span>).
        </p>
        <label className="mt-2 flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          I verified the fingerprint above through a different channel
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
          >
            Close
          </button>
          <button
            type="button"
            disabled={!verified}
            onClick={onReplace}
            className="rounded bg-danger px-3 py-1 text-base text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Replace key and connect
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded border border-border bg-subtle/60 p-3 text-meta">
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <ShieldQuestion size={14} /> First time connecting to this host
      </div>
      <p className="mt-1.5 text-fg-muted">
        Can&apos;t verify <span className="font-mono">{info.host}</span>&apos;s authenticity.
        If the fingerprint matches what you expect, trust it and add it to{" "}
        <span className="font-mono">~/.ssh/known_hosts</span>.
      </p>
      <KeyRow label="Fingerprint" value={info.fingerprint} />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onTrust}
          className="rounded bg-accent px-3 py-1 text-base text-white"
        >
          Trust &amp; connect
        </button>
      </div>
    </div>
  );
}

function KeyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2 grid grid-cols-[6rem_1fr] items-baseline gap-x-2">
      <span className="text-fg-muted">{label}</span>
      <span className="break-all font-mono text-fg">{value}</span>
    </div>
  );
}
