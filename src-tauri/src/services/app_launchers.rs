//! 자주 쓰는 앱 런처 목록. `<config_dir>/duet/app-launchers.json`.
//!
//! 파일 브라우저 + 자주 실행하는 앱 런처 — 등록한 앱을 상단 툴바에서 원클릭 실행.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppLauncher {
    pub id: String,
    pub name: String,
    /// 실행 대상 절대경로 (mac `.app` 번들, win `.exe`, linux 실행파일).
    pub path: PathBuf,
}

pub struct AppLaunchersStore {
    path: PathBuf,
    inner: RwLock<Vec<AppLauncher>>,
}

impl AppLaunchersStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("app-launchers.json");
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
                serde_json::from_str::<Vec<AppLauncher>>(&text)
                    .map_err(|e| DuetError::Io(format!("app-launchers parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(items),
        }))
    }

    pub async fn list(&self) -> Vec<AppLauncher> {
        self.inner.read().await.clone()
    }

    pub async fn add(&self, name: String, path: PathBuf) -> Result<Vec<AppLauncher>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("app name required".into()));
        }
        let item = AppLauncher {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            path,
        };
        let mut v = self.inner.write().await;
        v.push(item);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    pub async fn rename(&self, id: &str, name: String) -> Result<Vec<AppLauncher>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("app name required".into()));
        }
        let mut v = self.inner.write().await;
        if let Some(a) = v.iter_mut().find(|a| a.id == id) {
            a.name = name;
        }
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    pub async fn remove(&self, id: &str) -> Result<Vec<AppLauncher>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|a| a.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    /// `order` 순서로 재배치 — 목록에 없는 id 는 무시, order 에 빠진 항목은 뒤에 보존.
    pub async fn reorder(&self, order: Vec<String>) -> Result<Vec<AppLauncher>, DuetError> {
        let mut v = self.inner.write().await;
        let mut reordered: Vec<AppLauncher> = order
            .iter()
            .filter_map(|id| v.iter().find(|a| &a.id == id).cloned())
            .collect();
        for a in v.iter() {
            if !reordered.iter().any(|x| x.id == a.id) {
                reordered.push(a.clone());
            }
        }
        *v = reordered;
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[AppLauncher]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("app-launchers serialize: {e}")))?;
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
    async fn add_list_rename_remove() {
        let dir = tempdir().unwrap();
        let s = AppLaunchersStore::load_from(&dir.path().join("a.json"))
            .await
            .unwrap();
        let snap = s
            .add("Calc".into(), PathBuf::from("/Applications/Calculator.app"))
            .await
            .unwrap();
        assert_eq!(snap.len(), 1);
        let id = snap[0].id.clone();
        let snap = s.rename(&id, "Calculator".into()).await.unwrap();
        assert_eq!(snap[0].name, "Calculator");
        s.remove(&id).await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn empty_name_rejected() {
        let dir = tempdir().unwrap();
        let s = AppLaunchersStore::load_from(&dir.path().join("a.json"))
            .await
            .unwrap();
        assert!(s.add("  ".into(), PathBuf::from("/x")).await.is_err());
    }

    #[tokio::test]
    async fn reorder_keeps_missing_at_end() {
        let dir = tempdir().unwrap();
        let s = AppLaunchersStore::load_from(&dir.path().join("a.json"))
            .await
            .unwrap();
        s.add("A".into(), PathBuf::from("/a")).await.unwrap();
        s.add("B".into(), PathBuf::from("/b")).await.unwrap();
        let list = s.list().await;
        let snap = s.reorder(vec![list[1].id.clone()]).await.unwrap();
        // B first (in order), A appended.
        assert_eq!(
            snap.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(),
            ["B", "A"]
        );
    }
}
