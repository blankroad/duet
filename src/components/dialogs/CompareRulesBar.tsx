import { useEffect, useState } from "react";
import { Filter, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { commands, type CompareRules } from "@/types/bindings";
import { buildSettingsPatch } from "@/lib/settingsPatch";
import { isImeComposing } from "@/lib/keyEvent";
import { initialTolerance } from "@/lib/compareRules";

/**
 * 비교 규칙 바 — 무시 패턴(glob) + mtime 허용오차 입력 후 Re-compare.
 * 마지막 규칙은 settings 에 영속(다음 비교 기본값). 재비교는 부모(onRecompare)가 수행.
 * 원격이 낀 비교면 허용오차 칸을 최소 ±2s 로 채운다 — 첫 비교(triggerCompare)와 같은 값.
 */
export function CompareRulesBar({
  onRecompare,
  busy,
  remote = false,
}: {
  onRecompare: (rules: CompareRules) => void;
  busy: boolean;
  /** 두 쪽 중 하나가 원격(SSH)인가. */
  remote?: boolean;
}) {
  const { t } = useTranslation();
  const [ignore, setIgnore] = useState("");
  const [tol, setTol] = useState(() => initialTolerance(0, remote));
  // 사용자가 허용오차를 직접 골랐는가. 원격 때문에 자동으로 올린 ±2s 를 다음 로컬 비교의
  // 기본값으로 저장하지 않으려고 — 직접 고른 값만 영속한다.
  const [tolTouched, setTolTouched] = useState(false);

  // 마운트 시 저장된 규칙으로 프리필.
  useEffect(() => {
    void (async () => {
      const r = await commands.settingsGet();
      if (r.status === "ok") {
        setIgnore((r.data.compare_ignore_globs ?? []).join(" "));
        setTol(
          initialTolerance(r.data.compare_mtime_tolerance_ms ?? 0, remote),
        );
      }
    })();
  }, [remote]);

  const run = () => {
    if (busy) return; // 비교 중 무시 칸 Enter — 버튼처럼 한 번만
    const globs = ignore
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onRecompare({ ignore_globs: globs, mtime_tolerance_ms: tol });
    // 다음 비교 기본값으로 영속(허용오차는 직접 고른 경우만).
    void commands.settingsSet(
      buildSettingsPatch({
        compare_ignore_globs: globs,
        compare_mtime_tolerance_ms: tolTouched ? tol : null,
      }),
    );
  };

  return (
    <div className="mb-2 flex items-center gap-2 text-meta">
      <Filter size={11} className="text-fg-muted" />
      <input
        value={ignore}
        onChange={(e) => setIgnore(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !isImeComposing(e)) run();
        }}
        placeholder={t("dialog.compare.ignorePlaceholder")}
        className="min-w-0 flex-1 rounded border border-border bg-subtle px-2 py-0.5 focus:border-accent focus:outline-none"
      />
      <select
        value={tol}
        onChange={(e) => {
          setTol(Number(e.target.value));
          setTolTouched(true);
        }}
        className="rounded border border-border bg-subtle px-1 py-0.5 focus:outline-none"
        title={t("dialog.compare.tolTitle")}
      >
        <option value={0}>{t("dialog.compare.tolExact")}</option>
        <option value={2000}>±2s</option>
        <option value={60000}>±1m</option>
      </select>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-subtle disabled:opacity-50"
      >
        <RefreshCw size={11} className={busy ? "animate-spin" : ""} />
        {busy ? t("dialog.compare.comparing") : t("dialog.compare.recompare")}
      </button>
    </div>
  );
}
