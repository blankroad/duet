//! 키 → command id 매핑. `<config_dir>/duet/keymap.toml`.
//!
//! TOML 형식:
//! ```toml
//! [bindings]
//! "Ctrl+T" = "tab.new"
//! "Ctrl+W" = "tab.close"
//! ```

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct KeymapBinding {
    pub key: String,
    pub command_id: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct KeymapToml {
    #[serde(default)]
    bindings: BTreeMap<String, String>,
}

pub struct KeymapStore {
    path: PathBuf,
    inner: RwLock<Vec<KeymapBinding>>,
}

impl KeymapStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("keymap.toml");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let bindings = read_file(path).await?;
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(bindings),
        }))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn list(&self) -> Vec<KeymapBinding> {
        self.inner.read().await.clone()
    }

    /// 외부 source (file watcher) 가 호출 — bindings 통째로 교체.
    pub async fn replace(&self, bindings: Vec<KeymapBinding>) {
        let mut v = self.inner.write().await;
        *v = bindings;
    }

    pub async fn set(
        &self,
        key: String,
        command_id: String,
    ) -> Result<Vec<KeymapBinding>, DuetError> {
        if key.trim().is_empty() {
            return Err(DuetError::Io("key required".into()));
        }
        let mut v = self.inner.write().await;
        if let Some(existing) = v.iter_mut().find(|b| b.key == key) {
            existing.command_id = command_id;
        } else {
            v.push(KeymapBinding { key, command_id });
        }
        let snap = v.clone();
        write_file(&self.path, &snap).await?;
        Ok(snap)
    }

    pub async fn unset(&self, key: &str) -> Result<Vec<KeymapBinding>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|b| b.key != key);
        let snap = v.clone();
        write_file(&self.path, &snap).await?;
        Ok(snap)
    }

    pub async fn reset(&self) -> Result<Vec<KeymapBinding>, DuetError> {
        let mut v = self.inner.write().await;
        v.clear();
        write_file(&self.path, &[]).await?;
        Ok(Vec::new())
    }
}

pub async fn read_file(path: &Path) -> Result<Vec<KeymapBinding>, DuetError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = tokio::fs::read_to_string(path)
        .await
        .map_err(DuetError::from)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: KeymapToml =
        toml::from_str(&text).map_err(|e| DuetError::Io(format!("keymap parse: {e}")))?;
    Ok(parsed
        .bindings
        .into_iter()
        .map(|(key, command_id)| KeymapBinding { key, command_id })
        .collect())
}

async fn write_file(path: &Path, items: &[KeymapBinding]) -> Result<(), DuetError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(DuetError::from)?;
    }
    let mut bindings = BTreeMap::new();
    for b in items {
        bindings.insert(b.key.clone(), b.command_id.clone());
    }
    let toml_doc = KeymapToml { bindings };
    let text = toml::to_string_pretty(&toml_doc)
        .map_err(|e| DuetError::Io(format!("keymap serialize: {e}")))?;
    tokio::fs::write(path, text)
        .await
        .map_err(DuetError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn empty_file_returns_empty() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn set_and_unset() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.set("Ctrl+W".into(), "tab.close".into()).await.unwrap();
        assert_eq!(s.list().await.len(), 2);
        s.unset("Ctrl+T").await.unwrap();
        assert_eq!(s.list().await.len(), 1);
    }

    #[tokio::test]
    async fn set_same_key_replaces() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.set("Ctrl+T".into(), "tab.close".into()).await.unwrap();
        let list = s.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].command_id, "tab.close");
    }

    #[tokio::test]
    async fn reset_clears_all() {
        let dir = tempdir().unwrap();
        let s = KeymapStore::load_from(&dir.path().join("k.toml"))
            .await
            .unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        s.reset().await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn roundtrip_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("k.toml");
        let s = KeymapStore::load_from(&path).await.unwrap();
        s.set("Ctrl+T".into(), "tab.new".into()).await.unwrap();
        let s2 = KeymapStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].key, "Ctrl+T");
        assert_eq!(list[0].command_id, "tab.new");
    }
}
