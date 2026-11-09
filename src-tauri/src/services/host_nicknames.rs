//! 호스트 표시 별명 (display nickname) — `<config_dir>/duet/host-nicknames.json`.
//!
//! `{ alias: nickname }` 맵. alias = ssh-config alias 또는 saved/ad-hoc alias(재접속에도
//! 안정). 사이드바·패널·상태바가 `user@host_ip` 대신 사용자 지정 이름을 표시하는 데 쓰임.

use crate::fs::persist;
use crate::services::settings::duet_config_dir;
use crate::services::startup_notices::StartupNotice;
use crate::types::DuetError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// alias → nickname 맵. In-memory cache + on-disk JSON.
pub struct HostNicknamesStore {
    path: PathBuf,
    inner: RwLock<HashMap<String, String>>,
    /// 시작 시 손상 파일을 보존하고 기본값으로 복구한 내역.
    load_notice: Option<StartupNotice>,
}

impl HostNicknamesStore {
    /// `<config_dir>/duet/host-nicknames.json` 초기화 — 없으면 빈 맵.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("host-nicknames.json");
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
                serde_json::from_str::<HashMap<String, String>>(text)
                    .map_err(|e| format!("host nicknames parse: {e}"))
            },
            HashMap::new,
        )
        .await;
        let (value, load_notice) = match loaded {
            Ok(loaded) => (
                loaded.value,
                loaded.quarantined.as_ref().map(StartupNotice::from),
            ),
            Err(error) => {
                tracing::warn!("host nicknames load failed: {error}");
                (HashMap::new(), None)
            }
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(value),
            load_notice,
        }))
    }

    /// 시작 로드 때 손상 파일을 복구했으면 그 알림.
    pub fn load_notice(&self) -> Option<StartupNotice> {
        self.load_notice.clone()
    }

    /// 전체 맵 반환.
    pub async fn list(&self) -> HashMap<String, String> {
        self.inner.read().await.clone()
    }

    /// 별명 설정 — 빈 문자열이면 제거(기본 alias 표시로 복귀). 갱신된 맵 반환.
    pub async fn set(
        &self,
        alias: String,
        nickname: String,
    ) -> Result<HashMap<String, String>, DuetError> {
        let mut current = self.inner.write().await;
        let mut m = current.clone();
        if nickname.trim().is_empty() {
            m.remove(&alias);
        } else {
            m.insert(alias, nickname.trim().to_string());
        }
        let snap = m.clone();
        self.write_to_disk(&snap).await?;
        *current = snap.clone();
        Ok(snap)
    }

    /// 별명 제거. 갱신된 맵 반환.
    pub async fn remove(&self, alias: &str) -> Result<HashMap<String, String>, DuetError> {
        let mut current = self.inner.write().await;
        let mut m = current.clone();
        m.remove(alias);
        let snap = m.clone();
        self.write_to_disk(&snap).await?;
        *current = snap.clone();
        Ok(snap)
    }

    async fn write_to_disk(&self, map: &HashMap<String, String>) -> Result<(), DuetError> {
        let text = serde_json::to_string_pretty(map)
            .map_err(|e| DuetError::Io(format!("host nicknames serialize: {e}")))?;
        persist::write_atomic(&self.path, text.as_bytes()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn failed_saves_keep_memory_unchanged() {
        let dir = tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let store = HostNicknamesStore::load_from(&blocker.join("store.json"))
            .await
            .unwrap();
        store.inner.write().await.insert("a".into(), "Old".into());
        let before = serde_json::to_value(store.list().await).unwrap();
        assert!(store.set("a".into(), "new".into()).await.is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
        assert!(store.set("a".into(), String::new()).await.is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
        assert!(store.remove("a").await.is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
    }

    #[tokio::test]
    async fn read_io_error_still_starts_empty_without_notice() {
        let dir = tempdir().unwrap();
        let store = HostNicknamesStore::load_from(dir.path()).await.unwrap();
        assert!(store.list().await.is_empty());
        assert!(store.load_notice().is_none());
    }

    #[tokio::test]
    async fn corrupt_file_is_preserved_and_loads_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("store.json");
        let broken = b"[{broken";
        std::fs::write(&path, broken).unwrap();
        let store = HostNicknamesStore::load_from(&path).await.unwrap();
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
    }

    #[tokio::test]
    async fn set_get_remove_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("n.json");
        let s = HostNicknamesStore::load_from(&path).await.unwrap();
        s.set("prod-1".into(), "Production".into()).await.unwrap();
        // 재로드 후 유지
        let s2 = HostNicknamesStore::load_from(&path).await.unwrap();
        assert_eq!(
            s2.list().await.get("prod-1").map(String::as_str),
            Some("Production")
        );
        // 빈 문자열 = 제거
        s2.set("prod-1".into(), "  ".into()).await.unwrap();
        assert!(!s2.list().await.contains_key("prod-1"));
    }

    #[tokio::test]
    async fn remove_nonexistent_noop() {
        let dir = tempdir().unwrap();
        let s = HostNicknamesStore::load_from(&dir.path().join("n.json"))
            .await
            .unwrap();
        s.remove("ghost").await.unwrap();
        assert!(s.list().await.is_empty());
    }
}
