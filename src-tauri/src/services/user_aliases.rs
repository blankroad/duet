//! 사용자 정의 navigation alias. `<config_dir>/duet/user-aliases.json`.

use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, Location};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 사용자 정의 alias. uuid v7 id, 사용자 지정 이름, alias 종류.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UserAlias {
    /// uuid v7 문자열 — 고유 키.
    pub id: String,
    /// 사용자 지정 표시 이름.
    pub name: String,
    /// alias 종류 (Navigate 또는 Connect).
    pub kind: AliasKind,
}

/// alias 동작 종류.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AliasKind {
    /// 지정 위치로 이동.
    Navigate { location: Location },
    /// 저장된 호스트에 연결.
    Connect { saved_host_alias: String },
}

/// In-memory cache + on-disk JSON. 동시 접근 RwLock.
pub struct UserAliasesStore {
    path: PathBuf,
    inner: RwLock<Vec<UserAlias>>,
}

impl UserAliasesStore {
    /// `<config_dir>/duet/user-aliases.json` 위치에 store 초기화 — 파일 없으면 빈 목록.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("user-aliases.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 store 초기화. 파일 없으면 빈 목록.
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let items = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<UserAlias>>(&text)
                    .map_err(|e| DuetError::Io(format!("user-aliases parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(items),
        }))
    }

    /// 전체 alias 목록 반환.
    pub async fn list(&self) -> Vec<UserAlias> {
        self.inner.read().await.clone()
    }

    /// 새 alias 추가. id 는 uuid v7 자동 발급.
    ///
    /// name 이 공백이면 `DuetError::Io` 반환.
    pub async fn add(&self, name: String, kind: AliasKind) -> Result<Vec<UserAlias>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("alias name required".into()));
        }
        let item = UserAlias {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            kind,
        };
        let mut v = self.inner.write().await;
        v.push(item);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    /// id 로 제거. 없으면 no-op (Ok 반환).
    pub async fn remove(&self, id: &str) -> Result<Vec<UserAlias>, DuetError> {
        let mut v = self.inner.write().await;
        v.retain(|a| a.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[UserAlias]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("user-aliases serialize: {e}")))?;
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

    #[tokio::test]
    async fn add_navigate_then_remove() {
        let dir = tempdir().unwrap();
        let s = UserAliasesStore::load_from(&dir.path().join("a.json"))
            .await
            .unwrap();
        let after = s
            .add(
                "go-tmp".into(),
                AliasKind::Navigate {
                    location: Location {
                        source: SourceId::Local,
                        path: PathBuf::from("/tmp"),
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(after.len(), 1);
        let id = after[0].id.clone();
        s.remove(&id).await.unwrap();
        assert!(s.list().await.is_empty());
    }

    #[tokio::test]
    async fn add_connect_alias_serializes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.json");
        let s = UserAliasesStore::load_from(&path).await.unwrap();
        s.add(
            "prod".into(),
            AliasKind::Connect {
                saved_host_alias: "prod-server".into(),
            },
        )
        .await
        .unwrap();
        let s2 = UserAliasesStore::load_from(&path).await.unwrap();
        let list = s2.list().await;
        assert_eq!(list.len(), 1);
        match &list[0].kind {
            AliasKind::Connect { saved_host_alias } => {
                assert_eq!(saved_host_alias, "prod-server");
            }
            _ => panic!("expected Connect"),
        }
    }

    #[tokio::test]
    async fn empty_name_rejected() {
        let dir = tempdir().unwrap();
        let s = UserAliasesStore::load_from(&dir.path().join("a.json"))
            .await
            .unwrap();
        let res = s
            .add(
                "  ".into(),
                AliasKind::Navigate {
                    location: Location {
                        source: SourceId::Local,
                        path: PathBuf::from("/x"),
                    },
                },
            )
            .await;
        assert!(res.is_err());
    }
}
