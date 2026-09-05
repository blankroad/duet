//! 호스트별 즐겨찾기. `<config_dir>/duet/host-favorites.json`.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct HostFavorite {
    pub id: String,
    pub host_alias: String,
    pub name: String,
    pub path: PathBuf,
}

pub struct HostFavoritesStore {
    path: PathBuf,
    inner: RwLock<Vec<HostFavorite>>,
}

impl HostFavoritesStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("host-favorites.json");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let items = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<HostFavorite>>(&text)
                    .map_err(|e| DuetError::Io(format!("host-favorites parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(items),
        }))
    }

    pub async fn list(&self) -> Vec<HostFavorite> {
        self.inner.read().await.clone()
    }

    pub async fn add(
        &self,
        host_alias: String,
        name: String,
        path: PathBuf,
    ) -> Result<Vec<HostFavorite>, DuetError> {
        if host_alias.trim().is_empty() {
            return Err(DuetError::Io("host_alias required".into()));
        }
        if name.trim().is_empty() {
            return Err(DuetError::Io("favorite name required".into()));
        }
        let mut v = self.inner.write().await;
        // 같은 (호스트, 경로)는 한 번만 — 예전엔 ★/Ctrl+D 를 누를 때마다 같은 폴더가
        // 계속 쌓였다(프론트가 원격에서는 토글이 아니라 추가만 했기 때문).
        if let Some(existing) = v
            .iter()
            .find(|f| f.host_alias == host_alias && f.path == path)
        {
            let _ = existing;
            return Ok(v.clone());
        }
        let item = HostFavorite {
            id: uuid::Uuid::now_v7().to_string(),
            host_alias,
            name,
            path,
        };
        v.push(item);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    /// 이름만 변경 — 경로/호스트/순서/태그는 그대로. 없는 id 는 no-op.
    pub async fn rename(&self, id: &str, name: String) -> Result<Vec<HostFavorite>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("favorite name required".into()));
        }
        let mut v = self.inner.write().await;
        if let Some(f) = v.iter_mut().find(|f| f.id == id) {
            f.name = name;
        }
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    pub async fn remove(&self, id: &str) -> Result<Vec<HostFavorite>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|f| f.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    /// `order` 에 담긴 id 들만 그 순서대로 재배치 — 나머지 항목은 원위치 유지.
    ///
    /// 프론트는 한 alias 그룹의 id 들만 보내므로, 그 id 가 차지하던 슬롯에만 새
    /// 순서를 채워 다른 그룹 위치를 건드리지 않는다.
    pub async fn reorder(&self, order: Vec<String>) -> Result<Vec<HostFavorite>, DuetError> {
        let mut v = self.inner.write().await;
        let slots: Vec<usize> = v
            .iter()
            .enumerate()
            .filter(|(_, f)| order.contains(&f.id))
            .map(|(i, _)| i)
            .collect();
        let ordered: Vec<HostFavorite> = order
            .iter()
            .filter_map(|id| v.iter().find(|f| &f.id == id).cloned())
            .collect();
        for (slot, item) in slots.into_iter().zip(ordered.into_iter()) {
            v[slot] = item;
        }
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[HostFavorite]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("host-favorites serialize: {e}")))?;
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
    async fn add_list_remove() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json"))
            .await
            .unwrap();
        s.add("srv1".into(), "logs".into(), PathBuf::from("/var/log"))
            .await
            .unwrap();
        s.add("srv1".into(), "app".into(), PathBuf::from("/opt/app"))
            .await
            .unwrap();
        s.add("srv2".into(), "home".into(), PathBuf::from("/home/u"))
            .await
            .unwrap();
        let list = s.list().await;
        assert_eq!(list.len(), 3);
        let id = list[0].id.clone();
        s.remove(&id).await.unwrap();
        assert_eq!(s.list().await.len(), 2);
    }

    /// 같은 (호스트, 경로) 를 다시 추가해도 하나만 — ★/Ctrl+D 를 두 번 눌러도
    /// 즐겨찾기가 쌓이지 않아야 한다.
    #[tokio::test]
    async fn add_is_idempotent_per_host_and_path() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json"))
            .await
            .unwrap();
        s.add("srv1".into(), "logs".into(), PathBuf::from("/var/log"))
            .await
            .unwrap();
        let after = s
            .add(
                "srv1".into(),
                "logs again".into(),
                PathBuf::from("/var/log"),
            )
            .await
            .unwrap();
        assert_eq!(after.len(), 1, "같은 호스트·경로는 하나만");
        assert_eq!(after[0].name, "logs", "기존 이름을 덮어쓰지 않는다");
        // 경로가 다르면 별개.
        let other = s
            .add("srv1".into(), "app".into(), PathBuf::from("/opt/app"))
            .await
            .unwrap();
        assert_eq!(other.len(), 2);
    }

    #[tokio::test]
    async fn rename_keeps_path_and_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("hf.json");
        let s = HostFavoritesStore::load_from(&path).await.unwrap();
        let list = s
            .add("srv1".into(), "logs".into(), PathBuf::from("/var/log"))
            .await
            .unwrap();
        let id = list[0].id.clone();
        s.rename(&id, "프로덕션 로그".into()).await.unwrap();

        let reloaded = HostFavoritesStore::load_from(&path).await.unwrap();
        let items = reloaded.list().await;
        assert_eq!(items[0].name, "프로덕션 로그");
        assert_eq!(items[0].path, PathBuf::from("/var/log"));
        assert_eq!(items[0].id, id, "이름만 바뀌고 id 는 그대로");
        assert!(reloaded.rename(&id, "  ".into()).await.is_err());
    }

    #[tokio::test]
    async fn empty_alias_or_name_rejected() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json"))
            .await
            .unwrap();
        assert!(s
            .add("  ".into(), "x".into(), PathBuf::from("/x"))
            .await
            .is_err());
        assert!(s
            .add("a".into(), "  ".into(), PathBuf::from("/x"))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reorder_within_group_keeps_other_groups() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json"))
            .await
            .unwrap();
        s.add("srv1".into(), "logs".into(), PathBuf::from("/var/log"))
            .await
            .unwrap();
        s.add("srv1".into(), "app".into(), PathBuf::from("/opt/app"))
            .await
            .unwrap();
        s.add("srv2".into(), "home".into(), PathBuf::from("/home/u"))
            .await
            .unwrap();
        let list = s.list().await; // [srv1/logs, srv1/app, srv2/home]
                                   // srv1 그룹만 app, logs 순으로 swap — srv2/home 위치 2 유지
        let snap = s
            .reorder(vec![list[1].id.clone(), list[0].id.clone()])
            .await
            .unwrap();
        assert_eq!(
            snap.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            ["app", "logs", "home"]
        );
    }

    #[tokio::test]
    async fn remove_nonexistent_noop() {
        let dir = tempdir().unwrap();
        let s = HostFavoritesStore::load_from(&dir.path().join("hf.json"))
            .await
            .unwrap();
        s.remove("ghost").await.unwrap();
        assert!(s.list().await.is_empty());
    }
}
