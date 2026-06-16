//! 영속 설정. `<config_dir>/duet/settings.toml`.
//!
//! 필드 추가 시 `Default` impl + TOML 호환성 (없는 키는 default).

use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

fn default_theme() -> String {
    "system".into()
}
fn default_sort() -> String {
    "name".into()
}
fn default_view() -> String {
    "details".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Settings {
    /// 영구 삭제 (Shift+Delete) 메뉴 활성화. CLAUDE.md §3 — 디폴트 false.
    #[serde(default)]
    pub permanent_delete_enabled: bool,
    /// 비교창 기본 무시 패턴(glob) — 마지막 사용 규칙 영속.
    #[serde(default)]
    pub compare_ignore_globs: Vec<String>,
    /// 비교창 기본 mtime 허용오차(ms).
    #[serde(default)]
    pub compare_mtime_tolerance_ms: i64,
    /// UI 테마: "system" | "light" | "dark". 프론트가 `data-theme` 로 적용.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// 새 탭 기본 정렬: "name" | "size" | "mtime" | "kind" | "ext".
    #[serde(default = "default_sort")]
    pub default_sort: String,
    /// 새 탭 기본 뷰: "details" | "grid" | "tiles".
    #[serde(default = "default_view")]
    pub default_view: String,
    /// 새 탭에서 숨김 파일 기본 표시 여부.
    #[serde(default)]
    pub show_hidden_default: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            permanent_delete_enabled: false,
            compare_ignore_globs: Vec::new(),
            compare_mtime_tolerance_ms: 0,
            theme: default_theme(),
            default_sort: default_sort(),
            default_view: default_view(),
            show_hidden_default: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Type, Default)]
pub struct SettingsPatch {
    pub permanent_delete_enabled: Option<bool>,
    pub compare_ignore_globs: Option<Vec<String>>,
    pub compare_mtime_tolerance_ms: Option<i64>,
    pub theme: Option<String>,
    pub default_sort: Option<String>,
    pub default_view: Option<String>,
    pub show_hidden_default: Option<bool>,
}

/// In-memory cache + on-disk TOML. 동시 접근은 RwLock.
pub struct SettingsStore {
    path: PathBuf,
    inner: RwLock<Settings>,
}

impl SettingsStore {
    /// `<config_dir>/duet/settings.toml` 위치에 store 초기화 — 파일 없으면 default.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("settings.toml");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let settings = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            toml::from_str::<Settings>(&text)
                .map_err(|e| DuetError::Io(format!("settings parse: {e}")))?
        } else {
            Settings::default()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(settings),
        }))
    }

    pub async fn get(&self) -> Settings {
        self.inner.read().await.clone()
    }

    pub async fn apply(&self, patch: SettingsPatch) -> Result<Settings, DuetError> {
        let mut s = self.inner.write().await;
        if let Some(v) = patch.permanent_delete_enabled {
            s.permanent_delete_enabled = v;
        }
        if let Some(v) = patch.compare_ignore_globs {
            s.compare_ignore_globs = v;
        }
        if let Some(v) = patch.compare_mtime_tolerance_ms {
            s.compare_mtime_tolerance_ms = v;
        }
        if let Some(v) = patch.theme {
            s.theme = v;
        }
        if let Some(v) = patch.default_sort {
            s.default_sort = v;
        }
        if let Some(v) = patch.default_view {
            s.default_view = v;
        }
        if let Some(v) = patch.show_hidden_default {
            s.show_hidden_default = v;
        }
        let snapshot = s.clone();
        // 디스크 동기화 — write lock 잡은 채로 (race 방지)
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = toml::to_string_pretty(&snapshot)
            .map_err(|e| DuetError::Io(format!("settings serialize: {e}")))?;
        tokio::fs::write(&self.path, text)
            .await
            .map_err(DuetError::from)?;
        Ok(snapshot)
    }
}

/// `<config_dir>/duet` — 모든 영속 데이터 (settings, journal, trash 메타) 의 루트.
pub fn duet_config_dir() -> Result<PathBuf, DuetError> {
    dirs::config_dir()
        .map(|d| d.join("duet"))
        .ok_or_else(|| DuetError::Io("config dir not available".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn missing_file_uses_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        let store = SettingsStore::load_from(&path).await.unwrap();
        assert!(!store.get().await.permanent_delete_enabled);
    }

    #[tokio::test]
    async fn round_trip_patch() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        let store = SettingsStore::load_from(&path).await.unwrap();

        let updated = store
            .apply(SettingsPatch {
                permanent_delete_enabled: Some(true),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(updated.permanent_delete_enabled);

        // 새 store 로 다시 읽어서 영속 확인
        let store2 = SettingsStore::load_from(&path).await.unwrap();
        assert!(store2.get().await.permanent_delete_enabled);
    }

    #[tokio::test]
    async fn compare_rules_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        let store = SettingsStore::load_from(&path).await.unwrap();
        store
            .apply(SettingsPatch {
                compare_ignore_globs: Some(vec!["node_modules".into(), "*.log".into()]),
                compare_mtime_tolerance_ms: Some(2000),
                ..Default::default()
            })
            .await
            .unwrap();
        let store2 = SettingsStore::load_from(&path).await.unwrap();
        let s = store2.get().await;
        assert_eq!(s.compare_ignore_globs, vec!["node_modules", "*.log"]);
        assert_eq!(s.compare_mtime_tolerance_ms, 2000);
    }

    #[tokio::test]
    async fn unknown_keys_in_toml_dont_fail() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.toml");
        tokio::fs::write(&path, "permanent_delete_enabled = false\nfuture_key = 42\n")
            .await
            .unwrap();
        let store = SettingsStore::load_from(&path).await.unwrap();
        assert!(!store.get().await.permanent_delete_enabled);
    }
}
