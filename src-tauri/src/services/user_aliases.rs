//! 사용자 정의 navigation alias. `<config_dir>/duet/user-aliases.json`.

use crate::fs::persist;
use crate::services::settings::duet_config_dir;
use crate::services::startup_notices::StartupNotice;
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
    /// 시작 시 손상 파일을 보존하고 기본값으로 복구한 내역.
    load_notice: Option<StartupNotice>,
}

impl UserAliasesStore {
    /// `<config_dir>/duet/user-aliases.json` 위치에 store 초기화 — 파일 없으면 빈 목록.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("user-aliases.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 store 초기화. 파일 없으면 빈 목록.
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let loaded = persist::load_or_quarantine(
            path,
            |text| {
                if text.trim().is_empty() {
                    return Ok(Vec::new());
                }
                serde_json::from_str::<Vec<UserAlias>>(text)
                    .map_err(|e| format!("user-aliases parse: {e}"))
            },
            Vec::new,
        )
        .await?;
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(loaded.value),
            load_notice: loaded.quarantined.as_ref().map(StartupNotice::from),
        }))
    }

    /// 시작 로드 때 손상 파일을 복구했으면 그 알림.
    pub fn load_notice(&self) -> Option<StartupNotice> {
        self.load_notice.clone()
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
        let mut current = self.inner.write().await;
        let mut v = current.clone();
        v.push(item);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        *current = snap.clone();
        Ok(snap)
    }

    /// id 로 제거. 없으면 no-op (Ok 반환).
    pub async fn remove(&self, id: &str) -> Result<Vec<UserAlias>, DuetError> {
        let mut current = self.inner.write().await;
        let mut v = current.clone();
        v.retain(|a| a.id != id);
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        *current = snap.clone();
        Ok(snap)
    }

    async fn write_to_disk(&self, items: &[UserAlias]) -> Result<(), DuetError> {
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("user-aliases serialize: {e}")))?;
        persist::write_atomic(&self.path, text.as_bytes()).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SourceId;
    use tempfile::tempdir;

    #[tokio::test]
    async fn failed_saves_keep_memory_unchanged() {
        let dir = tempdir().unwrap();
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let store = UserAliasesStore::load_from(&blocker.join("store.json"))
            .await
            .unwrap();
        *store.inner.write().await = vec![UserAlias {
            id: "a".into(),
            name: "A".into(),
            kind: AliasKind::Connect {
                saved_host_alias: "host".into(),
            },
        }];
        let before = serde_json::to_value(store.list().await).unwrap();
        assert!(store
            .add(
                "new".into(),
                AliasKind::Connect {
                    saved_host_alias: "host".into()
                }
            )
            .await
            .is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
        assert!(store.remove("a").await.is_err());
        assert_eq!(serde_json::to_value(store.list().await).unwrap(), before);
    }

    #[tokio::test]
    async fn corrupt_file_is_preserved_and_loads_defaults() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("store.json");
        let broken = b"[{broken";
        std::fs::write(&path, broken).unwrap();
        let store = UserAliasesStore::load_from(&path).await.unwrap();
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
