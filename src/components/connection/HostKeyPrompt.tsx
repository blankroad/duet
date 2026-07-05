import { useState } from "react";
import { useTranslation, Trans } from "react-i18next";
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
  const { t } = useTranslation();
  const [verified, setVerified] = useState(false);
  if (info.changed) {
    return (
      <div className="mt-3 rounded border border-danger/60 bg-danger/10 p-3 text-meta">
        <div className="flex items-center gap-1.5 font-medium text-danger">
          <ShieldAlert size={14} /> {t("dialog.hostKey.changedTitle")}
        </div>
        <p className="mt-1.5 text-fg">
          <Trans
            i18nKey="dialog.hostKey.changedBody"
            values={{ host: info.host }}
            components={{ 1: <span className="font-mono" />, 3: <b /> }}
          />
        </p>
        <KeyRow
          label={t("dialog.hostKey.presentedKey")}
          value={info.fingerprint}
        />
        <p className="mt-1.5 text-fg-muted">
          <Trans
            i18nKey={
              info.changed_line != null
                ? "dialog.hostKey.changedVerifyLine"
                : "dialog.hostKey.changedVerify"
            }
            values={{ line: info.changed_line }}
            components={{
              1: <b />,
              3: <span className="font-mono" />,
              5: <span className="font-mono" />,
              7: <span className="font-mono" />,
            }}
          />
        </p>
        <label className="mt-2 flex items-center gap-2 text-fg">
          <input
            type="checkbox"
            checked={verified}
            onChange={(e) => setVerified(e.target.checked)}
          />
          {t("dialog.hostKey.verifiedCheck")}
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
          >
            {t("common.close")}
          </button>
          <button
            type="button"
            disabled={!verified}
            onClick={onReplace}
            className="rounded bg-danger px-3 py-1 text-base text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("dialog.hostKey.replaceCta")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded border border-border bg-subtle/60 p-3 text-meta">
      <div className="flex items-center gap-1.5 font-medium text-fg">
        <ShieldQuestion size={14} /> {t("dialog.hostKey.firstTitle")}
      </div>
      <p className="mt-1.5 text-fg-muted">
        <Trans
          i18nKey="dialog.hostKey.firstBody"
          values={{ host: info.host }}
          components={{
            1: <span className="font-mono" />,
            3: <span className="font-mono" />,
          }}
        />
      </p>
      <KeyRow
        label={t("dialog.hostKey.fingerprint")}
        value={info.fingerprint}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          onClick={onTrust}
          className="rounded bg-accent px-3 py-1 text-base text-white"
        >
          {t("dialog.hostKey.trustCta")}
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
