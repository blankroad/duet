import { useEffect, useState } from "react";
import { Filter, RefreshCw } from "lucide-react";
import { commands, type CompareRules } from "@/types/bindings";

/**
 * 비교 규칙 바 — 무시 패턴(glob) + mtime 허용오차 입력 후 Re-compare.
 * 마지막 규칙은 settings 에 영속(다음 비교 기본값). 재비교는 부모(onRecompare)가 수행.
 */
export function CompareRulesBar({
  onRecompare,
  busy,
}: {
  onRecompare: (rules: CompareRules) => void;
  busy: boolean;
}) {
  const [ignore, setIgnore] = useState("");
  const [tol, setTol] = useState(0);

  // 마운트 시 저장된 규칙으로 프리필.
  useEffect(() => {
    void (async () => {
      const r = await commands.settingsGet();
      if (r.status === "ok") {
        setIgnore((r.data.compare_ignore_globs ?? []).join(" "));
        setTol(r.data.compare_mtime_tolerance_ms ?? 0);
      }
    })();
  }, []);

  const run = () => {
    const globs = ignore
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onRecompare({ ignore_globs: globs, mtime_tolerance_ms: tol });
    // 다음 비교 기본값으로 영속.
    void commands.settingsSet({
      permanent_delete_enabled: null,
      compare_ignore_globs: globs,
      compare_mtime_tolerance_ms: tol,
      theme: null,
      default_sort: null,
      default_view: null,
      show_hidden_default: null,
    });
  };

  return (
    <div className="mb-2 flex items-center gap-2 text-meta">
      <Filter size={11} className="text-fg-muted" />
      <input
        value={ignore}
        onChange={(e) => setIgnore(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run()}
        placeholder="Ignore patterns (node_modules .git *.log)"
        className="min-w-0 flex-1 rounded border border-border bg-subtle px-2 py-0.5 focus:border-accent focus:outline-none"
      />
      <select
        value={tol}
        onChange={(e) => setTol(Number(e.target.value))}
        className="rounded border border-border bg-subtle px-1 py-0.5 focus:outline-none"
        title="mtime tolerance — same size + time diff within this = treated equal (absorbs SSH↔local false diffs)"
      >
        <option value={0}>mtime exact</option>
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
        {busy ? "비교 중…" : "Re-compare"}
      </button>
    </div>
  );
}
