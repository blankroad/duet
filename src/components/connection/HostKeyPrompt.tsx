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
          <ShieldAlert size={14} /> 호스트 키가 변경되었습니다 — 연결을 차단했습니다
        </div>
        <p className="mt-1.5 text-fg">
          <span className="font-mono">{info.host}</span> 의 서버 키가 기록된 것과 다릅니다.
          서버 재설치일 수도 있지만 <b>중간자 공격(MITM)</b> 일 수도 있습니다.
        </p>
        <KeyRow label="제시된 키" value={info.fingerprint} />
        <p className="mt-1.5 text-fg-muted">
          이 fingerprint 가 신뢰할 수 있는 출처(서버 관리자/콘솔 등)와 일치하는지{" "}
          <b>다른 경로로</b> 확인하세요. 확인되면 아래에서 키를 교체할 수 있습니다 — 기존{" "}
          <span className="font-mono">~/.ssh/known_hosts</span>
          {info.changed_line != null && (
            <>
              {" "}
              의 <span className="font-mono">{info.changed_line}</span> 번째 항목
            </>
          )}{" "}
          은 백업(<span className="font-mono">.duet-bak</span>) 후 제거됩니다.
        </p>
        <label className="mt-2 flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          위 fingerprint 를 다른 경로로 확인했습니다
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
          >
            닫기
          </button>
          <button
            type="button"
            disabled={!verified}
            onClick={onReplace}
            className="rounded bg-danger px-3 py-1 text-base text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            키 교체 후 연결
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded border border-border bg-subtle/60 p-3 text-meta">
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <ShieldQuestion size={14} /> 처음 연결하는 호스트입니다
      </div>
      <p className="mt-1.5 text-fg-muted">
        <span className="font-mono">{info.host}</span> 의 신뢰성을 확인할 수 없습니다.
        fingerprint 가 예상과 일치하면 신뢰하고 <span className="font-mono">~/.ssh/known_hosts</span>{" "}
        에 추가합니다.
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
