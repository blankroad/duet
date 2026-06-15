import { useState } from "react";
import { Filter, RefreshCw } from "lucide-react";
import type { CompareRules } from "@/types/bindings";

/**
 * 비교 규칙 바 — 무시 패턴(glob) + mtime 허용오차 입력 후 Re-compare.
 * 입력 상태는 이 컴포넌트가 소유; 실제 재비교는 부모(onRecompare)가 수행.
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

  const run = () => {
    const globs = ignore
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    onRecompare({ ignore_globs: globs, mtime_tolerance_ms: tol });
  };

  return (
    <div className="mb-2 flex items-center gap-2 text-meta">
      <Filter size={11} className="text-fg-muted" />
      <input
        value={ignore}
        onChange={(e) => setIgnore(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run()}
        placeholder="무시 패턴 (node_modules .git *.log)"
        className="min-w-0 flex-1 rounded border border-border bg-subtle px-2 py-0.5 focus:border-accent focus:outline-none"
      />
      <select
        value={tol}
        onChange={(e) => setTol(Number(e.target.value))}
        className="rounded border border-border bg-subtle px-1 py-0.5 focus:outline-none"
        title="mtime 허용오차 — 크기 같고 시각 차가 이 이내면 동일 취급 (SSH↔로컬 오탐 흡수)"
      >
        <option value={0}>mtime 정확</option>
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
