//! 사용자 북마크 (any location). `<config_dir>/duet/bookmarks.json`.
//!
//! Bookmark { id (uuid v7), name, location: Location }.
//! SavedHostsStore 와 동일 패턴.

use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, Location};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 사용자 북마크. uuid v7 id, 사용자 지정 이름, 임의 위치.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Bookmark {
    /// uuid v7 문자열 — 고유 키.
    pub id: String,
    /// 사용자 지정 표시 이름.
    pub name: String,
    /// 북마크된 위치 (로컬 또는 SSH).
    pub location: Location,
}

/// In-memory cache + on-disk JSON. 동시 접근 RwLock.
pub struct BookmarksStore {
    path: PathBuf,
    inner: RwLock<Vec<Bookmark>>,
}

impl BookmarksStore {
    /// `<config_dir>/duet/bookmarks.json` 위치에 store 초기화 — 파일 없으면 빈 목록.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("bookmarks.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 store 초기화. 파일 없으면 빈 목록.
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let bookmarks = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<Bookmark>>(&text)
                    .map_err(|e| DuetError::Io(format!("bookmarks parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(bookmarks),
        }))
    }

    /// 전체 북마크 목록 반환.
    pub async fn list(&self) -> Vec<Bookmark> {
        self.inner.read().await.clone()
    }

    /// 새 북마크 추가. id 는 uuid v7 자동 발급.
    ///
    /// name 이 공백이면 `DuetError::Io` 반환.
    pub async fn add(&self, name: String, location: Location) -> Result<Vec<Bookmark>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("bookmark name required".into()));
        }
        let bm = Bookmark {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            location,
        };
        let mut v = self.inner.write().await;
        v.push(bm);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    /// id 로 제거. 없으면 no-op (Ok 반환).
    pub async fn remove(&self, id: &str) -> Result<Vec<Bookmark>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|b| b.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[Bookmark]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("bookmarks serialize: {e}")))?;
        tokio::fs::write(&self.path, text)
            .await
            .map_err(DuetError::from)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SourceId;
    use tempfile::tempdir;

    fn loc(p: &str) -> Location {
        Location {
            source: SourceId::Local,
            path: PathBuf::from(p),
        }
    }

    #[tokio::test]
    async fn empty_then_add_then_reload() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("b.json");
        let s = BookmarksStore::load_from(&path).await.unwrap();
        assert!(s.list().await.is_empty());
        s.add("Project".into(), loc("/home/u/proj")).await.unwrap();
        s.add("Tmp".into(), loc("/tmp")).await.unwrap();
        let s2 = BookmarksStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "Project");
    }

    #[tokio::test]
    async fn remove_by_id() {
        let dir = tempdir().unwrap();
        let s = BookmarksStore::load_from(&dir.path().join("b.json"))
            .await
            .unwrap();
        let after_add = s.add("X".into(), loc("/x")).await.unwrap();
        let id = after_add[0].id.clone();
        s.remove(&id).await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn remove_nonexistent_noop() {
        let dir = tempdir().unwrap();
        let s = BookmarksStore::load_from(&dir.path().join("b.json"))
            .await
            .unwrap();
        s.remove("ghost").await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn empty_name_rejected() {
        let dir = tempdir().unwrap();
        let s = BookmarksStore::load_from(&dir.path().join("b.json"))
            .await
            .unwrap();
        assert!(s.add("  ".into(), loc("/x")).await.is_err());
    }
}
