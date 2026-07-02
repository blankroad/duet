//! 호스트 표시 별명 (display nickname) — `<config_dir>/duet/host-nicknames.json`.
//!
//! `{ alias: nickname }` 맵. alias = ssh-config alias 또는 saved/ad-hoc alias(재접속에도
//! 안정). 사이드바·패널·상태바가 `user@host_ip` 대신 사용자 지정 이름을 표시하는 데 쓰임.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// alias → nickname 맵. In-memory cache + on-disk JSON.
pub struct HostNicknamesStore {
    path: PathBuf,
    inner: RwLock<HashMap<String, String>>,
}

impl HostNicknamesStore {
    /// `<config_dir>/duet/host-nicknames.json` 초기화 — 없으면 빈 맵.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("host-nicknames.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 초기화. 없음/파싱 실패면 빈 맵(캐시성 데이터, 손상 무시).
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let map = if path.exists() {
            tokio::fs::read_to_string(path)
                .await
                .ok()
                .filter(|t| !t.trim().is_empty())
                .and_then(|t| serde_json::from_str::<HashMap<String, String>>(&t).ok())
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(map),
        }))
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
        let mut m = self.inner.write().await;
        if nickname.trim().is_empty() {
            m.remove(&alias);
        } else {
            m.insert(alias, nickname.trim().to_string());
        }
        let snap = m.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    /// 별명 제거. 갱신된 맵 반환.
    pub async fn remove(&self, alias: &str) -> Result<HashMap<String, String>, DuetError> {
        let mut m = self.inner.write().await;
        m.remove(alias);
        let snap = m.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, map: &HashMap<String, String>) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(map)
            .map_err(|e| DuetError::Io(format!("host nicknames serialize: {e}")))?;
        tokio::fs::write(&self.path, text)
            .await
            .map_err(DuetError::from)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
