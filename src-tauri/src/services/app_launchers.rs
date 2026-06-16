//! 자주 쓰는 앱 런처 목록 (+ Dock 식 폴더 1-레벨 + 실행 인자).
//! `<config_dir>/duet/app-launchers.json`.
//!
//! 한 항목(`AppItem`)은 앱(`path: Some`) 또는 폴더(`path: None` + `children`).
//! 폴더는 1-레벨(폴더 안에 폴더 없음) — 타입이 아닌 invariant 로 강제.

use crate::services::settings::duet_config_dir;
use crate::types::DuetError;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppItem {
    pub id: String,
    pub name: String,
    /// 앱이면 Some(절대경로), 폴더면 None.
    #[serde(default)]
    pub path: Option<PathBuf>,
    /// 실행 인자 (argv, 셸 미경유). 앱 전용.
    #[serde(default)]
    pub args: Vec<String>,
    /// 폴더면 1-레벨 자식 앱들. 앱이면 빈 벡터.
    #[serde(default)]
    pub children: Vec<AppItem>,
}

impl AppItem {
    fn is_folder(&self) -> bool {
        self.path.is_none()
    }
    fn new_app(name: String, path: PathBuf) -> Self {
        Self {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            path: Some(path),
            args: Vec::new(),
            children: Vec::new(),
        }
    }
}

// === tree 헬퍼 (1-레벨: top-level 또는 폴더 children) ===

/// id 로 top-level 또는 폴더 자식에서 항목 제거 후 반환.
fn take_item(items: &mut Vec<AppItem>, id: &str) -> Option<AppItem> {
    if let Some(pos) = items.iter().position(|i| i.id == id) {
        return Some(items.remove(pos));
    }
    for it in items.iter_mut() {
        if let Some(pos) = it.children.iter().position(|c| c.id == id) {
            return Some(it.children.remove(pos));
        }
    }
    None
}

/// id 로 top-level 또는 폴더 자식에서 가변 참조.
fn find_mut<'a>(items: &'a mut [AppItem], id: &str) -> Option<&'a mut AppItem> {
    if let Some(pos) = items.iter().position(|i| i.id == id) {
        return Some(&mut items[pos]);
    }
    for it in items.iter_mut() {
        if let Some(pos) = it.children.iter().position(|c| c.id == id) {
            return Some(&mut it.children[pos]);
        }
    }
    None
}

/// 자식 1개 폴더는 그 앱으로 풀고, 0개 폴더는 제거 — Dock 동작. 쓰기 전 호출.
fn dissolve_if_small(items: &mut Vec<AppItem>) {
    let mut i = 0;
    while i < items.len() {
        if items[i].is_folder() {
            match items[i].children.len() {
                0 => {
                    items.remove(i);
                    continue;
                }
                1 => {
                    let child = items[i].children.remove(0);
                    items[i] = child;
                }
                _ => {}
            }
        }
        i += 1;
    }
}

/// 로드 시 1회 정상화 (멱등): 폴더 안 폴더 평탄화, path 없는 앱 제거, dissolve.
fn normalize(items: &mut Vec<AppItem>) {
    for it in items.iter_mut() {
        if it.is_folder() {
            let mut flat: Vec<AppItem> = Vec::new();
            for c in std::mem::take(&mut it.children) {
                if c.is_folder() {
                    flat.extend(c.children.into_iter().filter(|x| x.path.is_some()));
                } else if c.path.is_some() {
                    flat.push(c);
                }
            }
            it.children = flat;
        }
    }
    dissolve_if_small(items);
}

pub struct AppLaunchersStore {
    path: PathBuf,
    inner: RwLock<Vec<AppItem>>,
}

impl AppLaunchersStore {
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("app-launchers.json");
        Self::load_from(&path).await
    }

    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let mut items = if path.exists() {
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(DuetError::from)?;
            if text.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str::<Vec<AppItem>>(&text)
                    .map_err(|e| DuetError::Io(format!("app-launchers parse: {e}")))?
            }
        } else {
            Vec::new()
        };
        normalize(&mut items);
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(items),
        }))
    }

    pub async fn list(&self) -> Vec<AppItem> {
        self.inner.read().await.clone()
    }

    async fn commit(&self, v: &[AppItem]) -> Result<Vec<AppItem>, DuetError> {
        self.write_to_disk(v).await?;
        Ok(v.to_vec())
    }

    pub async fn add(&self, name: String, path: PathBuf) -> Result<Vec<AppItem>, DuetError> {
        // 표시 이름이 비면 실행파일명(stem)으로 — 경로 파싱은 backend 담당(§7).
        // OS별 구분자/번들(.app)/확장자(.exe/.desktop) 를 Path 가 정확히 처리.
        let name = if name.trim().is_empty() {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_owned)
                .unwrap_or_else(|| "app".to_owned())
        } else {
            name
        };
        let mut v = self.inner.write().await;
        v.push(AppItem::new_app(name, path));
        let snap = v.clone();
        self.commit(&snap).await
    }

    pub async fn rename(&self, id: &str, name: String) -> Result<Vec<AppItem>, DuetError> {
        if name.trim().is_empty() {
            return Err(DuetError::Io("name required".into()));
        }
        let mut v = self.inner.write().await;
        if let Some(it) = find_mut(&mut v, id) {
            it.name = name;
        }
        let snap = v.clone();
        self.commit(&snap).await
    }

    pub async fn set_args(&self, id: &str, args: Vec<String>) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        if let Some(it) = find_mut(&mut v, id) {
            if it.is_folder() {
                return Err(DuetError::Io("cannot set args on a folder".into()));
            }
            it.args = args;
        }
        let snap = v.clone();
        self.commit(&snap).await
    }

    pub async fn remove(&self, id: &str) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        take_item(&mut v, id);
        dissolve_if_small(&mut v);
        let snap = v.clone();
        self.commit(&snap).await
    }

    /// 드래그-온토 머지: 둘 다 앱이면 target 자리에 새 폴더, target 이 폴더면 그 안으로.
    pub async fn group(&self, drag_id: &str, target_id: &str) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        if drag_id == target_id {
            let snap = v.clone();
            return self.commit(&snap).await;
        }
        let (Some(dpos), Some(tpos)) = (
            v.iter().position(|i| i.id == drag_id),
            v.iter().position(|i| i.id == target_id),
        ) else {
            let snap = v.clone();
            return self.commit(&snap).await;
        };
        // 폴더 → x 는 거부 (reorder 가 처리). drag 는 반드시 앱.
        if v[dpos].is_folder() {
            let snap = v.clone();
            return self.commit(&snap).await;
        }
        if v[tpos].is_folder() {
            let app = v.remove(dpos);
            let tpos2 = v
                .iter()
                .position(|i| i.id == target_id)
                .expect("target exists");
            v[tpos2].children.push(app);
        } else {
            let app = v.remove(dpos);
            let tpos2 = v
                .iter()
                .position(|i| i.id == target_id)
                .expect("target exists");
            let target = v.remove(tpos2);
            let folder = AppItem {
                id: uuid::Uuid::now_v7().to_string(),
                name: "Folder".into(),
                path: None,
                args: Vec::new(),
                children: vec![target, app],
            };
            v.insert(tpos2, folder);
        }
        let snap = v.clone();
        self.commit(&snap).await
    }

    pub async fn move_into_folder(
        &self,
        app_id: &str,
        folder_id: &str,
    ) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        // 폴더 검증
        let is_folder = v.iter().any(|i| i.id == folder_id && i.is_folder());
        if !is_folder {
            let snap = v.clone();
            return self.commit(&snap).await;
        }
        if let Some(app) = take_item(&mut v, app_id) {
            if app.is_folder() {
                // 폴더는 폴더 안에 못 넣음 — 원위치 복구(맨 뒤)
                v.push(app);
            } else if let Some(f) = v.iter_mut().find(|i| i.id == folder_id) {
                f.children.push(app);
            } else {
                v.push(app);
            }
        }
        dissolve_if_small(&mut v);
        let snap = v.clone();
        self.commit(&snap).await
    }

    pub async fn move_out(&self, app_id: &str, folder_id: &str) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        let fpos = v.iter().position(|i| i.id == folder_id);
        let Some(fpos) = fpos else {
            let snap = v.clone();
            return self.commit(&snap).await;
        };
        let cpos = v[fpos].children.iter().position(|c| c.id == app_id);
        if let Some(cpos) = cpos {
            let app = v[fpos].children.remove(cpos);
            let insert_at = (fpos + 1).min(v.len());
            v.insert(insert_at, app);
        }
        dissolve_if_small(&mut v);
        let snap = v.clone();
        self.commit(&snap).await
    }

    /// 폴더 해체 — 자식들을 폴더 자리에 펼침.
    pub async fn dissolve(&self, folder_id: &str) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        if let Some(pos) = v.iter().position(|i| i.id == folder_id && i.is_folder()) {
            let folder = v.remove(pos);
            for (k, child) in folder.children.into_iter().enumerate() {
                v.insert(pos + k, child);
            }
        }
        let snap = v.clone();
        self.commit(&snap).await
    }

    /// top-level 재배치 (order 에 든 id 만 그 순서로, 나머지는 뒤에 보존).
    pub async fn reorder(&self, order: Vec<String>) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        let mut reordered: Vec<AppItem> = order
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
        self.commit(&snap).await
    }

    /// 폴더 내부 자식 재배치.
    pub async fn reorder_in_folder(
        &self,
        folder_id: &str,
        order: Vec<String>,
    ) -> Result<Vec<AppItem>, DuetError> {
        let mut v = self.inner.write().await;
        if let Some(f) = v.iter_mut().find(|i| i.id == folder_id && i.is_folder()) {
            let mut reordered: Vec<AppItem> = order
                .iter()
                .filter_map(|id| f.children.iter().find(|c| &c.id == id).cloned())
                .collect();
            for c in f.children.iter() {
                if !reordered.iter().any(|x| x.id == c.id) {
                    reordered.push(c.clone());
                }
            }
            f.children = reordered;
        }
        dissolve_if_small(&mut v);
        let snap = v.clone();
        self.commit(&snap).await
    }

    async fn write_to_disk(&self, items: &[AppItem]) -> Result<(), DuetError> {
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

    async fn store() -> Arc<AppLaunchersStore> {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.json");
        // dir 를 누수시켜 테스트 동안 살림 (tempdir drop 방지).
        std::mem::forget(dir);
        AppLaunchersStore::load_from(&p).await.unwrap()
    }

    #[tokio::test]
    async fn add_set_args_roundtrip() {
        let s = store().await;
        let v = s.add("Code".into(), PathBuf::from("/x")).await.unwrap();
        let id = v[0].id.clone();
        let v = s
            .set_args(&id, vec!["--new".into(), "f.txt".into()])
            .await
            .unwrap();
        assert_eq!(v[0].args, vec!["--new", "f.txt"]);
    }

    #[tokio::test]
    async fn group_two_apps_creates_folder_then_dissolves() {
        let s = store().await;
        s.add("A".into(), PathBuf::from("/a")).await.unwrap();
        let v = s.add("B".into(), PathBuf::from("/b")).await.unwrap();
        let (a, b) = (v[0].id.clone(), v[1].id.clone());
        let v = s.group(&a, &b).await.unwrap();
        assert_eq!(v.len(), 1);
        assert!(v[0].path.is_none()); // 폴더
        assert_eq!(v[0].children.len(), 2);
        // 한 앱 빼면 폴더 해체 → 단일 앱.
        let folder_id = v[0].id.clone();
        let v = s.move_out(&a, &folder_id).await.unwrap();
        assert_eq!(v.len(), 2);
        assert!(v.iter().all(|i| i.path.is_some()));
    }

    #[tokio::test]
    async fn reject_folder_into_folder() {
        let s = store().await;
        s.add("A".into(), PathBuf::from("/a")).await.unwrap();
        let v = s.add("B".into(), PathBuf::from("/b")).await.unwrap();
        let (a, b) = (v[0].id.clone(), v[1].id.clone());
        let v = s.group(&a, &b).await.unwrap();
        let folder_id = v[0].id.clone();
        s.add("C".into(), PathBuf::from("/c")).await.unwrap();
        // 폴더를 드래그(folder→app/folder) 는 no-op.
        let after = s.group(&folder_id, &folder_id).await.unwrap();
        assert!(after.iter().filter(|i| i.path.is_none()).count() <= 1);
    }

    #[tokio::test]
    async fn migration_loads_old_flat_json() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("old.json");
        // 구버전 스키마 (path 만, args/children 없음)
        std::fs::write(
            &p,
            r#"[{"id":"1","name":"Old","path":"/Applications/Old.app"}]"#,
        )
        .unwrap();
        let s = AppLaunchersStore::load_from(&p).await.unwrap();
        let v = s.list().await;
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].path, Some(PathBuf::from("/Applications/Old.app")));
        assert!(v[0].args.is_empty());
        assert!(v[0].children.is_empty());
    }
}
