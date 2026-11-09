//! 항목 태그 (다대다) — `<config_dir>/duet/tags.json`.
//!
//! `{ key: [tag, ...] }` 맵. key = 접두사 + 식별자(`host:<alias>` / `bm:<id>` /
//! `fav:<id>`). 호스트·북마크를 가로지르는 태그로 사이드바를 좁히는 데 쓰임.

use crate::fs::persist;
use crate::services::settings::duet_config_dir;
use crate::services::startup_notices::StartupNotice;
use crate::types::DuetError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// key → 태그 목록. In-memory cache + on-disk JSON.
pub struct TagsStore {
    path: PathBuf,
    inner: RwLock<HashMap<String, Vec<String>>>,
    /// 시작 시 손상 파일을 보존하고 기본값으로 복구한 내역.
    load_notice: Option<StartupNotice>,
    /// 시작 때 읽지 못한 원본을 덮어쓰지 않도록 저장을 막는 원인.
    read_failed: Option<String>,
}

impl TagsStore {
    /// `<config_dir>/duet/tags.json` 초기화 — 없으면 빈 맵.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("tags.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 초기화. 손상 파일은 보존하고 빈 맵으로 복구한다.
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let loaded = persist::load_or_quarantine(
            path,
            |text| {
                if text.trim().is_empty() {
                    return Ok(HashMap::new());
                }
                serde_json::from_str::<HashMap<String, Vec<String>>>(text)
                    .map_err(|e| format!("tags parse: {e}"))
            },
            HashMap::new,
        )
        .await;
        let (value, load_notice, read_failed) = match loaded {
            Ok(loaded) => (
                loaded.value,
                loaded.quarantined.as_ref().map(StartupNotice::from),
                None,
            ),
            Err(error) => {
                tracing::warn!("tags load failed: {error}");
                (HashMap::new(), None, Some(error.to_string()))
            }
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(value),
            load_notice,
            read_failed,
        }))
    }

    /// 시작 로드 때 손상 파일을 복구했으면 그 알림.
    pub fn load_notice(&self) -> Option<StartupNotice> {
        self.load_notice.clone()
    }

    /// 전체 맵 반환.
    pub async fn list(&self) -> HashMap<String, Vec<String>> {
        self.inner.read().await.clone()
    }

    /// 한 키의 태그를 교체 — trim·중복 제거 후 비면 키 삭제. 갱신된 맵 반환.
    pub async fn set(
        &self,
        key: String,
        tags: Vec<String>,
    ) -> Result<HashMap<String, Vec<String>>, DuetError> {
        let mut clean: Vec<String> = Vec::new();
        for t in tags {
            let t = t.trim().to_string();
            if !t.is_empty() && !clean.contains(&t) {
                clean.push(t);
            }
        }
        let mut current = self.inner.write().await;
        let mut m = current.clone();
        if clean.is_empty() {
            m.remove(&key);
        } else {
            m.insert(key, clean);
        }
        let snap = m.clone();
        self.write_to_disk(&snap).await?;
        *current = snap.clone();
        Ok(snap)
    }

    async fn write_to_disk(&self, map: &HashMap<String, Vec<String>>) -> Result<(), DuetError> {
        if let Some(reason) = &self.read_failed {
            return Err(DuetError::Io(format!(
                "tags.json could not be read at startup ({reason}); not overwriting it"
            )));
        }
        let text = serde_json::to_string_pretty(map)
            .map_err(|e| DuetError::Io(format!("tags serialize: {e}")))?;
        persist::write_atomic(&self.path, text.as_bytes()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_file_is_never_overwritten_by_empty_fallback() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("store.json");
        let original = r#"{"host:existing":["kept"]}"#;
        std::fs::write(&path, original).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let read_error = match std::fs::read(&path) {
            Ok(_) => {
                // root처럼 권한과 무관하게 읽을 수 있으면 이 재현을 건너뛴다.
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
                return;
            }
            Err(error) => error.to_string(),
        };
        let loaded = TagsStore::load_from(&path).await;
        if loaded.is_err() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let store = loaded.unwrap();
        let set_result = store.set("host:new".into(), vec!["new".into()]).await;
        let clear_result = store.set("host:new".into(), Vec::new()).await;
        let memory = store.list().await;
        // 실패한 코드에서도 assertion 전에 권한을 복원한다.
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();

        let error = set_result.expect_err("an unreadable original must not be overwritten");
        assert!(error.to_string().contains("could not be read at startup"));
        assert!(error.to_string().contains(&read_error));
        assert!(memory.is_empty());
        assert_eq!(on_disk, original);
        assert!(clear_result.is_err());
        let reloaded = TagsStore::load_from(&path).await.unwrap();
        let saved = reloaded
            .set("host:new".into(), vec!["new".into()])
            .await
            .unwrap();
        assert_eq!(saved.get("host:existing"), Some(&vec!["kept".to_string()]));
    }

    #[tokio::test]
    async fn failed_saves_keep_memory_unchanged() {
        let dir = tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let store = TagsStore::load_from(&blocker.join("store.json"))
            .await
            .unwrap();
        store
            .inner
            .write()
            .await
            .insert("host:a".into(), vec!["old".into()]);
        let before = serde_json::to_value(store.list().await).unwrap();
        assert!(store
            .set("host:a".into(), vec!["new".into()])
            .await
            .is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
        assert!(store.set("host:a".into(), Vec::new()).await.is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
    }

    #[tokio::test]
    async fn read_io_error_still_starts_empty_without_notice() {
        let dir = tempdir().unwrap();
        let store = TagsStore::load_from(dir.path()).await.unwrap();
        assert!(store.list().await.is_empty());
        assert!(store.load_notice().is_none());
    }

    #[tokio::test]
    async fn corrupt_file_is_preserved_and_loads_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("store.json");
        let broken = b"[{broken";
        std::fs::write(&path, broken).unwrap();
        let store = TagsStore::load_from(&path).await.unwrap();
        assert!(store.list().await.is_empty());
        assert!(store.load_notice().is_some());
        let backups: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("store.json.corrupt-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read(&backups[0]).unwrap(), broken);
        store
            .set("host:recovered".into(), vec!["new".into()])
            .await
            .unwrap();
        assert_eq!(std::fs::read(&backups[0]).unwrap(), broken);
    }

    #[tokio::test]
    async fn set_dedups_trims_and_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("t.json");
        let s = TagsStore::load_from(&path).await.unwrap();
        s.set(
            "host:prod-1".into(),
            vec![" prod ".into(), "prod".into(), "db".into()],
        )
        .await
        .unwrap();
        let s2 = TagsStore::load_from(&path).await.unwrap();
        assert_eq!(
            s2.list().await.get("host:prod-1").cloned(),
            Some(vec!["prod".into(), "db".into()])
        );
    }

    #[tokio::test]
    async fn empty_tags_remove_key() {
        let dir = tempdir().unwrap();
        let s = TagsStore::load_from(&dir.path().join("t.json"))
            .await
            .unwrap();
        s.set("bm:1".into(), vec!["x".into()]).await.unwrap();
        s.set("bm:1".into(), vec!["  ".into()]).await.unwrap();
        assert!(!s.list().await.contains_key("bm:1"));
    }
}
