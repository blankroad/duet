//! Saved hosts IPC commands — list / upsert / remove.

use std::sync::Arc;

use crate::services::saved_hosts::{SavedHost, SavedHostsStore};
use crate::types::DuetError;

/// 저장된 SSH 호스트 목록을 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn saved_hosts_list(
    store: tauri::State<'_, Arc<SavedHostsStore>>,
) -> Result<Vec<SavedHost>, DuetError> {
    Ok(store.list().await)
}

/// 호스트를 추가하거나 alias 기준으로 덮어쓴다.
#[tauri::command]
#[specta::specta]
pub async fn saved_hosts_upsert(
    host: SavedHost,
    store: tauri::State<'_, Arc<SavedHostsStore>>,
) -> Result<Vec<SavedHost>, DuetError> {
    store.upsert(host).await
}

/// alias 로 호스트를 제거한다. 없으면 no-op.
#[tauri::command]
#[specta::specta]
pub async fn saved_hosts_remove(
    alias: String,
    store: tauri::State<'_, Arc<SavedHostsStore>>,
) -> Result<Vec<SavedHost>, DuetError> {
    store.remove(&alias).await
}
