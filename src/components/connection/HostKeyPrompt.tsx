import { ShieldQuestion, ShieldAlert } from "lucide-react";
import type { HostKeyInfo } from "@/types/bindings";

/**
 * 서버 호스트키 검증 결과 프롬프트 (OpenSSH 방식).
 *
 * - 미지의 호스트(TOFU): fingerprint 확인 후 "Trust & connect" → known_hosts 기록.
 * - 키 변경(MITM 위험): 신뢰 버튼 없음. ~/.ssh/known_hosts 의 충돌 라인 수동 수정 안내.
 *
 * 신뢰 결정은 사용자만 — fingerprint 를 보여주고 명시 승인을 받는다 (CLAUDE.md §9).
 */
export function HostKeyPrompt({
  info,
  onTrust,
  onCancel,
}: {
  info: HostKeyInfo;
  onTrust: () => void;
  onCancel: () => void;
}) {
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
          신뢰할 수 있는 변경임을 확인했다면 <span className="font-mono">~/.ssh/known_hosts</span>
          {info.changed_line != null && (
            <>
              {" "}
              의 <span className="font-mono">{info.changed_line}</span> 번째 줄
            </>
          )}{" "}
          을 수동으로 제거한 뒤 다시 연결하세요.
        </p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
          >
            닫기
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
