//! Saved hosts 그룹(폴더) 오버레이 IPC. 그룹핑 로직은 FE, 여기선 get/set 영속만.

use std::sync::Arc;

use crate::services::host_groups::{HostGroup, HostGroupsStore};
use crate::types::DuetError;

/// 저장된 그룹 목록.
#[tauri::command]
#[specta::specta]
pub async fn host_groups_list(
    store: tauri::State<'_, Arc<HostGroupsStore>>,
) -> Result<Vec<HostGroup>, DuetError> {
    Ok(store.list().await)
}

/// 그룹 구조 전체 교체 후 영속 — 정규화된 결과 반환.
#[tauri::command]
#[specta::specta]
pub async fn host_groups_set(
    groups: Vec<HostGroup>,
    store: tauri::State<'_, Arc<HostGroupsStore>>,
) -> Result<Vec<HostGroup>, DuetError> {
    store.set(groups).await
}
