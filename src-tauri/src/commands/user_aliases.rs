//! User aliases IPC — list / add / remove.

use std::sync::Arc;

use crate::services::user_aliases::{AliasKind, UserAlias, UserAliasesStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn user_aliases_list(
    store: tauri::State<'_, Arc<UserAliasesStore>>,
) -> Result<Vec<UserAlias>, DuetError> {
    Ok(store.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn user_aliases_add(
    name: String,
    kind: AliasKind,
    store: tauri::State<'_, Arc<UserAliasesStore>>,
) -> Result<Vec<UserAlias>, DuetError> {
    store.inner().add(name, kind).await
}

#[tauri::command]
#[specta::specta]
pub async fn user_aliases_remove(
    id: String,
    store: tauri::State<'_, Arc<UserAliasesStore>>,
) -> Result<Vec<UserAlias>, DuetError> {
    store.inner().remove(&id).await
}
