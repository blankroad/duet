//! Keymap IPC — list / set / unset / reset.

use std::sync::Arc;

use crate::services::keymap::{KeymapBinding, KeymapStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn keymap_list(
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    Ok(store.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn keymap_set(
    key: String,
    command_id: String,
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    store.inner().set(key, command_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn keymap_unset(
    key: String,
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    store.inner().unset(&key).await
}

#[tauri::command]
#[specta::specta]
pub async fn keymap_reset(
    store: tauri::State<'_, Arc<KeymapStore>>,
) -> Result<Vec<KeymapBinding>, DuetError> {
    store.inner().reset().await
}
