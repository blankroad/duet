import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import { commands } from "@/types/bindings";
import type { Settings, SettingsPatch } from "@/types/bindings";
import { applyTabDefaults, type SortKey, type ViewMode } from "@/stores/panes";
import { useAppSettings } from "@/stores/settings";
import { applyTheme } from "@/lib/theme";

const isWindows = platform() === "windows";

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
    single_click_open: null,
    ...over,
  };
}

const selectClass =
  "rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none";

export function GeneralSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  // 탐색기 "Open in duet" 우클릭 등록 상태 (Windows 전용, 레지스트리가 SoT).
  const [openInDuet, setOpenInDuet] = useState(false);
  const [openInDuetBusy, setOpenInDuetBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setSettings(r.data);
      setLoading(false);
    });
    if (isWindows) {
      commands.openInDuetGet().then((r) => {
        if (!cancelled && r.status === "ok") setOpenInDuet(r.data);
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleOpenInDuet = async (enabled: boolean) => {
    setOpenInDuetBusy(true);
    const r = await commands.openInDuetSet(enabled);
    setOpenInDuetBusy(false);
    if (r.status === "ok") setOpenInDuet(r.data);
  };

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
    useAppSettings.getState().setSingleClickOpen(r.data.single_click_open ?? false);
  };

  if (loading || !settings) return <div className="text-base text-fg-muted">Loading…</div>;

  return (
    <div className="space-y-4">
      {/* 외관 */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">Theme</div>
          <div className="text-meta text-fg-muted">System follows your OS setting.</div>
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
          <div className="text-meta text-fg-muted">Show dotfiles from the start.</div>
        </div>
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.single_click_open}
          onChange={(e) => void save({ single_click_open: e.target.checked })}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">Open items with a single click</div>
          <div className="text-meta text-fg-muted">
            Single-click opens folders and files. Off = double-click (default). Hold Ctrl/Shift to
            select without opening.
          </div>
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
          <div className="text-base">Enable permanent delete (Shift+Delete)</div>
          <div className="text-meta text-fg-muted">
            Off by default. Even when on, deleting requires typing a word to confirm.
          </div>
          {settings.permanent_delete_enabled && (
            <div className="mt-1 flex items-center gap-1 text-meta text-danger">
              <AlertTriangle size={11} /> Permanent delete is risky.
            </div>
          )}
        </div>
      </label>

      {/* Windows 탐색기 통합 (Windows 전용) */}
      {isWindows && (
        <label className="flex items-start gap-2 border-t border-border pt-3">
          <input
            type="checkbox"
            checked={openInDuet}
            disabled={openInDuetBusy}
            onChange={(e) => void toggleOpenInDuet(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-base">Add &ldquo;Open in duet&rdquo; to the folder right-click menu</div>
            <div className="text-meta text-fg-muted">
              Windows only. Adds a per-user registry entry (no admin) so right-clicking a
              folder or drive can open it in duet. Fully reversible — turning this off removes
              the entry. Tip: turn it off before uninstalling.
            </div>
          </div>
        </label>
      )}
    </div>
  );
}
