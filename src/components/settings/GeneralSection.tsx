import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import { commands } from "@/types/bindings";
import type { Settings, SettingsPatch } from "@/types/bindings";
import { applyTabDefaults, type SortKey, type ViewMode } from "@/stores/panes";
import { useAppSettings } from "@/stores/settings";
import { useUI, type Density } from "@/stores/ui";
import { applyTheme } from "@/lib/theme";
import { buildSettingsPatch as buildPatch } from "@/lib/settingsPatch";

const isWindows = platform() === "windows";

const selectClass =
  "rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none";

export function GeneralSection() {
  const density = useUI((s) => s.density);
  const setDensity = useUI((s) => s.setDensity);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  // 탐색기 통합 상태 (Windows 전용, 레지스트리가 SoT). 두 토글이 같은 키군을 만지므로
  // busy 플래그 하나로 직렬화한다.
  const [openInDuet, setOpenInDuet] = useState(false);
  const [defaultHandler, setDefaultHandler] = useState(false);
  const [shellBusy, setShellBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    commands.settingsGet().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setSettings(r.data);
      setLoading(false);
    });
    if (isWindows) {
      void Promise.all([
        commands.openInDuetGet(),
        commands.defaultFolderHandlerGet(),
      ]).then(([a, b]) => {
        if (cancelled) return;
        if (a.status === "ok") setOpenInDuet(a.data);
        if (b.status === "ok") setDefaultHandler(b.data);
      });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // 두 토글은 같은 레지스트리 키군을 공유한다(기본 핸들러를 켜면 우클릭 verb 도 등록되고,
  // 우클릭을 끄면 기본 핸들러 포인터도 함께 풀린다). 그래서 어느 쪽을 만지든 둘 다 다시 읽는다.
  const refreshShellStatus = async () => {
    const [a, b] = await Promise.all([
      commands.openInDuetGet(),
      commands.defaultFolderHandlerGet(),
    ]);
    if (a.status === "ok") setOpenInDuet(a.data);
    if (b.status === "ok") setDefaultHandler(b.data);
  };

  const toggleOpenInDuet = async (enabled: boolean) => {
    setShellBusy(true);
    await commands.openInDuetSet(enabled);
    await refreshShellStatus();
    setShellBusy(false);
  };

  const toggleDefaultHandler = async (enabled: boolean) => {
    setShellBusy(true);
    await commands.defaultFolderHandlerSet(enabled);
    await refreshShellStatus();
    setShellBusy(false);
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
    useAppSettings.getState().setShowThumbnails(r.data.show_thumbnails ?? true);
    useAppSettings.getState().setOsFileIcons(r.data.os_file_icons ?? isWindows);
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

      {/* 밀도 — 비민감 UI 설정이라 settings.toml 이 아닌 localStorage(useUI) 영속. */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">List density</div>
          <div className="text-meta text-fg-muted">
            Row height in file lists. Compact fits more items.
          </div>
        </div>
        <select
          className={selectClass}
          value={density}
          onChange={(e) => setDensity(e.target.value as Density)}
        >
          <option value="normal">Normal</option>
          <option value="compact">Compact</option>
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

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.show_thumbnails}
          onChange={(e) => void save({ show_thumbnails: e.target.checked })}
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">Show image thumbnails</div>
          <div className="text-meta text-fg-muted">
            Render thumbnails for images (PNG/JPG/GIF/WebP/BMP) in Grid and Tiles views. Cached on
            disk.
          </div>
        </div>
      </label>

      {isWindows && (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={settings.os_file_icons}
            onChange={(e) => void save({ os_file_icons: e.target.checked })}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-base">Use Windows file icons</div>
            <div className="text-meta text-fg-muted">
              Show the same per-type icons as File Explorer for local files. Off = duet&rsquo;s
              built-in colored glyphs. Remote (SSH) files always use glyphs.
            </div>
          </div>
        </label>
      )}

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
        <div className="space-y-2 border-t border-border pt-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={openInDuet}
              disabled={shellBusy}
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

          <label className="ml-6 flex items-start gap-2">
            <input
              type="checkbox"
              checked={defaultHandler}
              disabled={shellBusy}
              onChange={(e) => void toggleDefaultHandler(e.target.checked)}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-base">Open folders in duet by default (double-click)</div>
              <div className="text-meta text-fg-muted">
                Makes duet the default action when you double-click a folder or drive, instead of
                File Explorer. Enabling this also adds the right-click entry above. Reversible —
                turning it off restores Explorer. While duet is already running, opened folders
                appear as a new tab.
              </div>
            </div>
          </label>
        </div>
      )}
    </div>
  );
}
