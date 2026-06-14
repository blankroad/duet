//! 사용자 저장 SSH 호스트. `<config_dir>/duet/saved-hosts.json`.
//!
//! ad-hoc 다이얼로그에서 "Save host" 체크 시 추가됨. 비밀번호는 저장 안 함
//! (CLAUDE.md §5) — host/port/user/key_path 만.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 저장된 SSH 호스트 정보. 비밀번호 미포함 (CLAUDE.md §5).
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct SavedHost {
    /// 기본 키 — 사용자 지정 (기본값: `user@host:port`).
    pub alias: String,
    /// 호스트명 또는 IP.
    pub host: String,
    /// SSH 포트.
    pub port: u16,
    /// SSH 사용자명.
    pub user: String,
    /// SSH 키 파일 경로 (선택).
    pub key_path: Option<PathBuf>,
}

/// In-memory cache + on-disk JSON. 동시 접근 RwLock.
pub struct SavedHostsStore {
    path: PathBuf,
    inner: RwLock<Vec<SavedHost>>,
}

impl SavedHostsStore {
    /// `<config_dir>/duet/saved-hosts.json` 위치에 store 초기화 — 파일 없으면 빈 목록.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("saved-hosts.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 store 초기화. 파일 없으면 빈 목록.
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let hosts = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<SavedHost>>(&text)
                    .map_err(|e| DuetError::Io(format!("saved-hosts parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(hosts),
        }))
    }

    /// 전체 호스트 목록 반환.
    pub async fn list(&self) -> Vec<SavedHost> {
        self.inner.read().await.clone()
    }

    /// alias 로 추가 또는 교체 (idempotent — 같은 alias 면 overwrite).
    ///
    /// alias 가 공백이면 `DuetError::Io` 반환.
    pub async fn upsert(&self, host: SavedHost) -> Result<Vec<SavedHost>, DuetError> {
        if host.alias.trim().is_empty() {
            return Err(DuetError::Io("saved host alias required".into()));
        }
        let mut hosts = self.inner.write().await;
        if let Some(existing) = hosts.iter_mut().find(|h| h.alias == host.alias) {
            *existing = host;
        } else {
            hosts.push(host);
        }
        let snapshot = hosts.clone();
        self.write_to_disk(&snapshot).await?;
        Ok(snapshot)
    }

    /// alias 로 제거. 없으면 no-op (Ok 반환).
    pub async fn remove(&self, alias: &str) -> Result<Vec<SavedHost>, DuetError> {
        let mut hosts = self.inner.write().await;
        hosts.retain(|h| h.alias != alias);
        let snapshot = hosts.clone();
        self.write_to_disk(&snapshot).await?;
        Ok(snapshot)
    }

    /// `order` 에 담긴 alias 들만 그 순서대로 재배치 — 나머지 항목은 원위치 유지.
    pub async fn reorder(&self, order: Vec<String>) -> Result<Vec<SavedHost>, DuetError> {
        let mut hosts = self.inner.write().await;
        let slots: Vec<usize> = hosts
            .iter()
            .enumerate()
            .filter(|(_, h)| order.contains(&h.alias))
            .map(|(i, _)| i)
            .collect();
        let ordered: Vec<SavedHost> = order
            .iter()
            .filter_map(|a| hosts.iter().find(|h| &h.alias == a).cloned())
            .collect();
        for (slot, item) in slots.into_iter().zip(ordered.into_iter()) {
            hosts[slot] = item;
        }
        let snapshot = hosts.clone();
        self.write_to_disk(&snapshot).await?;
        Ok(snapshot)
    }

    async fn write_to_disk(&self, hosts: &[SavedHost]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(hosts)
            .map_err(|e| DuetError::Io(format!("saved-hosts serialize: {e}")))?;
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

    fn mk(alias: &str) -> SavedHost {
        SavedHost {
            alias: alias.into(),
            host: "192.0.2.1".into(),
            port: 22,
            user: "u".into(),
            key_path: None,
        }
    }

    #[tokio::test]
    async fn missing_file_empty() {
        let dir = tempdir().unwrap();
        let store = SavedHostsStore::load_from(&dir.path().join("h.json"))
            .await
            .unwrap();
        assert!(store.list().await.is_empty());
    }

    #[tokio::test]
    async fn upsert_then_load() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("h.json");
        let store = SavedHostsStore::load_from(&path).await.unwrap();
        store.upsert(mk("a")).await.unwrap();
        store.upsert(mk("b")).await.unwrap();
        let back = SavedHostsStore::load_from(&path).await.unwrap();
        let list = back.list().await;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].alias, "a");
        assert_eq!(list[1].alias, "b");
    }

    #[tokio::test]
    async fn upsert_same_alias_replaces() {
        let dir = tempdir().unwrap();
        let store = SavedHostsStore::load_from(&dir.path().join("h.json"))
            .await
            .unwrap();
        store.upsert(mk("a")).await.unwrap();
        let mut updated = mk("a");
        updated.host = "10.0.0.1".into();
        store.upsert(updated).await.unwrap();
        let list = store.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].host, "10.0.0.1");
    }

    #[tokio::test]
    async fn remove_existing_and_missing() {
        let dir = tempdir().unwrap();
        let store = SavedHostsStore::load_from(&dir.path().join("h.json"))
            .await
            .unwrap();
        store.upsert(mk("a")).await.unwrap();
        store.upsert(mk("b")).await.unwrap();
        store.remove("a").await.unwrap();
        store.remove("does-not-exist").await.unwrap(); // no-op
        let list = store.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].alias, "b");
    }

    #[tokio::test]
    async fn reorder_changes_order_and_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("h.json");
        let store = SavedHostsStore::load_from(&path).await.unwrap();
        store.upsert(mk("a")).await.unwrap();
        store.upsert(mk("b")).await.unwrap();
        store.upsert(mk("c")).await.unwrap();
        let snap = store
            .reorder(vec!["c".into(), "a".into(), "b".into()])
            .await
            .unwrap();
        assert_eq!(
            snap.iter().map(|h| h.alias.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
        let back = SavedHostsStore::load_from(&path).await.unwrap();
        assert_eq!(
            back.list()
                .await
                .iter()
                .map(|h| h.alias.as_str())
                .collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
    }

    #[tokio::test]
    async fn empty_alias_rejected() {
        let dir = tempdir().unwrap();
        let store = SavedHostsStore::load_from(&dir.path().join("h.json"))
            .await
            .unwrap();
        let bad = SavedHost {
            alias: "  ".into(),
            host: "x".into(),
            port: 22,
            user: "u".into(),
            key_path: None,
        };
        assert!(store.upsert(bad).await.is_err());
    }
}
