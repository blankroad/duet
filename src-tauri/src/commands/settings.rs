//! 설정 IPC commands.

use std::sync::Arc;

use crate::services::settings::{Settings, SettingsPatch, SettingsStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn settings_get(
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<Settings, DuetError> {
    Ok(store.get().await)
}

#[tauri::command]
#[specta::specta]
pub async fn settings_set(
    patch: SettingsPatch,
    store: tauri::State<'_, Arc<SettingsStore>>,
) -> Result<Settings, DuetError> {
    store.apply(patch).await
}
