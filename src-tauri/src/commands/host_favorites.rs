//! Host favorites IPC — list / add / remove.

use std::path::PathBuf;
use std::sync::Arc;

use crate::services::host_favorites::{HostFavorite, HostFavoritesStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn host_favorites_list(
    store: tauri::State<'_, Arc<HostFavoritesStore>>,
) -> Result<Vec<HostFavorite>, DuetError> {
    Ok(store.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn host_favorites_add(
    host_alias: String,
    name: String,
    path: PathBuf,
    store: tauri::State<'_, Arc<HostFavoritesStore>>,
) -> Result<Vec<HostFavorite>, DuetError> {
    store.add(host_alias, name, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn host_favorites_remove(
    id: String,
    store: tauri::State<'_, Arc<HostFavoritesStore>>,
) -> Result<Vec<HostFavorite>, DuetError> {
    store.remove(&id).await
}
