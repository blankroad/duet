import type { SettingsPatch } from "@/types/bindings";

/**
 * 모든 필드를 null 로 채운 SettingsPatch + override (특정 필드만 변경).
 *
 * SettingsPatch 는 backend 와 1:1 (필드 추가 시 여기 한 곳만 갱신하면 모든 섹션이 따라옴).
 */
export function buildSettingsPatch(
  over: Partial<SettingsPatch>,
): SettingsPatch {
  return {
    permanent_delete_enabled: null,
    compare_ignore_globs: null,
    compare_mtime_tolerance_ms: null,
    theme: null,
    default_sort: null,
    default_view: null,
    show_hidden_default: null,
    single_click_open: null,
    show_thumbnails: null,
    ext_icon_overrides: null,
    ext_app_overrides: null,
    ...over,
  };
}
