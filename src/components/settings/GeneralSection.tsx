import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { commands } from "@/types/bindings";
import type { Settings, SettingsPatch } from "@/types/bindings";
import { applyTabDefaults, type SortKey, type ViewMode } from "@/stores/panes";
import { applyTheme } from "@/lib/theme";

/** null 로 채운 전체 patch + override (특정 필드만 변경). */
function buildPatch(over: Partial<SettingsPatch>): SettingsPatch {
  return {
    permanent_delete_enabled: null,
    compare_ignore_globs: null,
    compare_mtime_tolerance_ms: null,
    theme: null,
    default_sort: null,
    default_view: null,
    show_hidden_default: null,
    ...over,
  };
}

const selectClass =
  "rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none";

export function GeneralSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setSettings(r.data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 저장 후 즉시 적용 (테마 + 새 탭 기본값) — 죽은 토글 방지.
  const save = async (over: Partial<SettingsPatch>) => {
    const r = await commands.settingsSet(buildPatch(over));
    if (r.status !== "ok") return;
    setSettings(r.data);
    applyTheme(r.data.theme ?? "system");
    applyTabDefaults({
      sortKey: (r.data.default_sort ?? "name") as SortKey,
      viewMode: (r.data.default_view ?? "details") as ViewMode,
      showHidden: r.data.show_hidden_default ?? false,
    });
  };

  if (loading || !settings) return <div className="text-base text-fg-muted">Loading…</div>;

  return (
    <div className="space-y-4">
      {/* 외관 */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">Theme</div>
          <div className="text-meta text-fg-muted">System 은 OS 설정을 따름.</div>
        </div>
        <select
          className={selectClass}
          value={settings.theme ?? "system"}
          onChange={(e) => void save({ theme: e.target.value })}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>

      {/* 새 탭 기본값 */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-base">Default sort (new tabs)</div>
        <select
          className={selectClass}
          value={settings.default_sort ?? "name"}
          onChange={(e) => void save({ default_sort: e.target.value })}
        >
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="mtime">Modified</option>
          <option value="kind">Kind</option>
          <option value="ext">Extension</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="text-base">Default view (new tabs)</div>
        <select
          className={selectClass}
          value={settings.default_view ?? "details"}
          onChange={(e) => void save({ default_view: e.target.value })}
        >
          <option value="details">Details</option>
          <option value="grid">Grid</option>
          <option value="tiles">Tiles</option>
        </select>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.show_hidden_default}
          onChange={(e) => void save({ show_hidden_default: e.target.checked })}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">Show hidden files by default</div>
          <div className="text-meta text-fg-muted">dotfiles 등을 시작부터 표시.</div>
        </div>
      </label>

      {/* 안전 */}
      <label className="flex items-start gap-2 border-t border-border pt-3">
        <input
          type="checkbox"
          checked={settings.permanent_delete_enabled}
          onChange={(e) => void save({ permanent_delete_enabled: e.target.checked })}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">Permanent delete (Shift+Delete) 활성화</div>
          <div className="text-meta text-fg-muted">
            CLAUDE.md §3 — 디폴트 OFF. 활성화해도 단어 타이핑 추가 확인 필요.
          </div>
          {settings.permanent_delete_enabled && (
            <div className="mt-1 flex items-center gap-1 text-meta text-danger">
              <AlertTriangle size={11} /> 영구 삭제 위험.
            </div>
          )}
        </div>
      </label>
    </div>
  );
}
