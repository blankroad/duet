//! 항목 태그 (다대다) — `<config_dir>/duet/tags.json`.
//!
//! `{ key: [tag, ...] }` 맵. key = 접두사 + 식별자(`host:<alias>` / `bm:<id>` /
//! `fav:<id>`). 호스트·북마크를 가로지르는 태그로 사이드바를 좁히는 데 쓰임.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// key → 태그 목록. In-memory cache + on-disk JSON.
pub struct TagsStore {
    path: PathBuf,
    inner: RwLock<HashMap<String, Vec<String>>>,
}

impl TagsStore {
    /// `<config_dir>/duet/tags.json` 초기화 — 없으면 빈 맵.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("tags.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 초기화. 없음/파싱 실패면 빈 맵(캐시성, 손상 무시).
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let map = if path.exists() {
            tokio::fs::read_to_string(path)
                .await
                .ok()
                .filter(|t| !t.trim().is_empty())
                .and_then(|t| serde_json::from_str::<HashMap<String, Vec<String>>>(&t).ok())
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
        let mut m = self.inner.write().await;
        if clean.is_empty() {
            m.remove(&key);
        } else {
            m.insert(key, clean);
        }
        let snap = m.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, map: &HashMap<String, Vec<String>>) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(map)
            .map_err(|e| DuetError::Io(format!("tags serialize: {e}")))?;
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
        assert!(s.list().await.get("bm:1").is_none());
    }
}
