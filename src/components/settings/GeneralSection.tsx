import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { platform } from "@tauri-apps/plugin-os";
import { commands } from "@/types/bindings";
import type { Settings, SettingsPatch } from "@/types/bindings";
import { applyTabDefaults, type SortKey, type ViewMode } from "@/stores/panes";
import { useTranslation } from "react-i18next";
import { syncAppSettings } from "@/stores/settings";
import { useUI, type Density } from "@/stores/ui";
import { setLang, storedLang, type LangSetting } from "@/i18n";
import { applyTheme } from "@/lib/theme";
import { buildSettingsPatch as buildPatch } from "@/lib/settingsPatch";

const isWindows = platform() === "windows";

const selectClass =
  "rounded border border-border bg-subtle px-2 py-1 text-base focus:border-accent focus:outline-none";

export function GeneralSection() {
  const { t } = useTranslation();
  const density = useUI((s) => s.density);
  const setDensity = useUI((s) => s.setDensity);
  // 언어 설정값 — setLang 이 i18n 언어를 바꾸면 useTranslation 이 리렌더.
  const [lang, setLangState] = useState<LangSetting>(storedLang());
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
    syncAppSettings(r.data);
  };

  if (loading || !settings)
    return (
      <div className="text-base text-fg-muted">{t("settings.loading")}</div>
    );

  return (
    <div className="space-y-4">
      {/* 언어 — localStorage(i18n) 영속. */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">{t("settings.language")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.languageHint")}
          </div>
        </div>
        <select
          className={selectClass}
          value={lang}
          onChange={(e) => {
            const v = e.target.value as LangSetting;
            setLangState(v);
            setLang(v);
          }}
        >
          <option value="system">{t("settings.langSystem")}</option>
          <option value="en">English</option>
          <option value="ko">한국어</option>
        </select>
      </div>

      {/* 외관 */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">{t("settings.theme")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.themeHint")}
          </div>
        </div>
        <select
          className={selectClass}
          value={settings.theme ?? "system"}
          onChange={(e) => void save({ theme: e.target.value })}
        >
          <option value="system">{t("settings.themeSystem")}</option>
          <option value="light">{t("settings.themeLight")}</option>
          <option value="dark">{t("settings.themeDark")}</option>
        </select>
      </div>

      {/* 밀도 — 비민감 UI 설정이라 settings.toml 이 아닌 localStorage(useUI) 영속. */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">{t("settings.density")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.densityHint")}
          </div>
        </div>
        <select
          className={selectClass}
          value={density}
          onChange={(e) => setDensity(e.target.value as Density)}
        >
          <option value="normal">{t("settings.densityNormal")}</option>
          <option value="compact">{t("settings.densityCompact")}</option>
        </select>
      </div>

      {/* 새 탭 기본값 */}
      <div className="flex items-center justify-between gap-2">
        <div className="text-base">{t("settings.defaultSort")}</div>
        <select
          className={selectClass}
          value={settings.default_sort ?? "name"}
          onChange={(e) => void save({ default_sort: e.target.value })}
        >
          <option value="name">{t("settings.sortName")}</option>
          <option value="size">{t("settings.sortSize")}</option>
          <option value="mtime">{t("settings.sortMtime")}</option>
          <option value="kind">{t("settings.sortKind")}</option>
          <option value="ext">{t("settings.sortExt")}</option>
        </select>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="text-base">{t("settings.defaultView")}</div>
        <select
          className={selectClass}
          value={settings.default_view ?? "details"}
          onChange={(e) => void save({ default_view: e.target.value })}
        >
          <option value="details">{t("settings.viewDetails")}</option>
          <option value="grid">{t("settings.viewGrid")}</option>
          <option value="tiles">{t("settings.viewTiles")}</option>
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
          <div className="text-base">{t("settings.showHidden")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.showHiddenHint")}
          </div>
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
          <div className="text-base">{t("settings.singleClick")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.singleClickHint")}
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
          <div className="text-base">{t("settings.thumbnails")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.thumbnailsHint")}
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
            <div className="text-base">{t("settings.winIcons")}</div>
            <div className="text-meta text-fg-muted">
              {t("settings.winIconsHint")}
            </div>
          </div>
        </label>
      )}

      {/* 파일 작업 — 충돌 기본값과 확인 다이얼로그 (매번 같은 선택을 다시 하지 않게) */}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <div>
          <div className="text-base">{t("settings.conflictDefault")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.conflictDefaultHint")}
          </div>
        </div>
        <select
          className={selectClass}
          value={settings.transfer_conflict_default ?? "skip"}
          onChange={(e) =>
            void save({ transfer_conflict_default: e.target.value })
          }
        >
          <option value="skip">{t("conflict.skip")}</option>
          <option value="keepboth">{t("conflict.keepBoth")}</option>
          <option value="replace">{t("conflict.replace")}</option>
        </select>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.remember_conflict_choice}
          onChange={(e) =>
            void save({ remember_conflict_choice: e.target.checked })
          }
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">{t("settings.rememberConflict")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.rememberConflictHint")}
          </div>
        </div>
      </label>

      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base">{t("settings.confirmTransfer")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.confirmTransferHint")}
          </div>
        </div>
        <select
          className={selectClass}
          value={settings.confirm_transfer ?? "conflicts_only"}
          onChange={(e) => void save({ confirm_transfer: e.target.value })}
        >
          <option value="conflicts_only">
            {t("settings.confirmConflictsOnly")}
          </option>
          <option value="always">{t("settings.confirmAlways")}</option>
          <option value="never">{t("settings.confirmNever")}</option>
        </select>
      </div>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={settings.confirm_trash_delete}
          onChange={(e) =>
            void save({ confirm_trash_delete: e.target.checked })
          }
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">{t("settings.confirmTrash")}</div>
          <div className="text-meta text-fg-muted">
            {t("settings.confirmTrashHint")}
          </div>
        </div>
      </label>

      {/* 안전 */}
      <label className="flex items-start gap-2 border-t border-border pt-3">
        <input
          type="checkbox"
          checked={settings.permanent_delete_enabled}
          onChange={(e) =>
            void save({ permanent_delete_enabled: e.target.checked })
          }
          className="mt-0.5"
        />
        <div className="flex-1">
          <div className="text-base">
            Enable permanent delete (Shift+Delete)
          </div>
          <div className="text-meta text-fg-muted">
            {t("settings.permDeleteHint")}
          </div>
          {settings.permanent_delete_enabled && (
            <div className="mt-1 flex items-center gap-1 text-meta text-danger">
              <AlertTriangle size={11} /> {t("settings.permDeleteWarn")}
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
              <div className="text-base">{t("settings.shellOpenIn")}</div>
              <div className="text-meta text-fg-muted">
                {t("settings.shellOpenInHint")}
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
              <div className="text-base">{t("settings.shellDefault")}</div>
              <div className="text-meta text-fg-muted">
                {t("settings.shellDefaultHint")}
              </div>
            </div>
          </label>
        </div>
      )}
    </div>
  );
}
