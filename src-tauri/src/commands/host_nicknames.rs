//! 호스트 별명 IPC — list / set / remove.

use std::collections::HashMap;
use std::sync::Arc;

use crate::services::host_nicknames::HostNicknamesStore;
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn host_nickname_list(
    store: tauri::State<'_, Arc<HostNicknamesStore>>,
) -> Result<HashMap<String, String>, DuetError> {
    Ok(store.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn host_nickname_set(
    alias: String,
    nickname: String,
    store: tauri::State<'_, Arc<HostNicknamesStore>>,
) -> Result<HashMap<String, String>, DuetError> {
    store.set(alias, nickname).await
}

#[tauri::command]
#[specta::specta]
pub async fn host_nickname_remove(
    alias: String,
    store: tauri::State<'_, Arc<HostNicknamesStore>>,
) -> Result<HashMap<String, String>, DuetError> {
    store.remove(&alias).await
}
