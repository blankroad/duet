//! 사이드바 Saved hosts 그룹(폴더) 오버레이. `<config_dir>/duet/host-groups.json`.
//!
//! **호스트 데이터를 복제하지 않는다** — `HostGroup.members` 는 saved-host 의
//! *alias* 만 참조한다. 따라서 saved-hosts.json 이 진실의 원천이고 이 파일은
//! 그룹핑 메타데이터(폴더 이름 + 멤버 alias 순서)만 담는다. saved host 가 삭제되면
//! 그 alias 는 렌더링 시 자연히 빠지고(FE 가 live 목록과 join), 다음 set 때 정리된다.
//!
//! fs 파괴가 없는 순수 설정 영속이라 journal/undo 대상이 아님 (app_launchers 류).

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 폴더 하나 — 안정 id + 표시 이름 + 멤버 alias 목록(순서 유지).
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    pub members: Vec<String>,
}

/// In-memory cache + on-disk JSON.
pub struct HostGroupsStore {
    path: PathBuf,
    inner: RwLock<Vec<HostGroup>>,
}

impl HostGroupsStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("host-groups.json");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let groups = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<HostGroup>>(&text)
                    .map_err(|e| DuetError::Io(format!("host-groups parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(groups),
        }))
    }

    pub async fn list(&self) -> Vec<HostGroup> {
        self.inner.read().await.clone()
    }

    /// 전체 그룹 구조를 교체 후 영속. 그룹핑 로직은 FE 가 수행하고(오버레이 메타라
    /// 단순) 여기서는 검증/정규화만: 빈 이름 거부, 같은 alias 가 여러 폴더에 중복
    /// 배정되지 않도록 앞선 폴더 우선으로 dedup.
    pub async fn set(&self, groups: Vec<HostGroup>) -> Result<Vec<HostGroup>, DuetError> {
        for g in &groups {
            if g.name.trim().is_empty() {
                return Err(DuetError::Io("group name required".into()));
            }
        }
        let mut seen = std::collections::HashSet::new();
        let normalized: Vec<HostGroup> = groups
            .into_iter()
            .map(|mut g| {
                g.members.retain(|a| seen.insert(a.clone()));
                g
            })
            .collect();
        {
            let mut inner = self.inner.write().await;
            *inner = normalized.clone();
        }
        self.write_to_disk(&normalized).await?;
        Ok(normalized)
    }

    async fn write_to_disk(&self, groups: &[HostGroup]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(groups)
            .map_err(|e| DuetError::Io(format!("host-groups serialize: {e}")))?;
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

    fn grp(id: &str, name: &str, members: &[&str]) -> HostGroup {
        HostGroup {
            id: id.into(),
            name: name.into(),
            members: members.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[tokio::test]
    async fn set_dedups_member_across_folders_and_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("host-groups.json");
        let store = HostGroupsStore::load_from(&path).await.unwrap();
        // "a" 가 두 폴더에 — 앞선 폴더(prod)만 보유.
        let out = store
            .set(vec![
                grp("g1", "prod", &["a", "b"]),
                grp("g2", "staging", &["a", "c"]),
            ])
            .await
            .unwrap();
        assert_eq!(out[0].members, vec!["a", "b"]);
        assert_eq!(out[1].members, vec!["c"]);
        // reload 시 영속 확인.
        let reloaded = HostGroupsStore::load_from(&path)
            .await
            .unwrap()
            .list()
            .await;
        assert_eq!(reloaded, out);
    }

    #[tokio::test]
    async fn set_rejects_empty_group_name() {
        let dir = tempdir().unwrap();
        let store = HostGroupsStore::load_from(&dir.path().join("g.json"))
            .await
            .unwrap();
        let r = store.set(vec![grp("g1", "  ", &["a"])]).await;
        assert!(matches!(r, Err(DuetError::Io(_))));
    }
}
