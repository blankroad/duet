//! 태그 IPC — list / set.

use std::collections::HashMap;
use std::sync::Arc;

use crate::services::tags::TagsStore;
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn tag_list(
    store: tauri::State<'_, Arc<TagsStore>>,
) -> Result<HashMap<String, Vec<String>>, DuetError> {
    Ok(store.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn tag_set(
    key: String,
    tags: Vec<String>,
    store: tauri::State<'_, Arc<TagsStore>>,
) -> Result<HashMap<String, Vec<String>>, DuetError> {
    store.set(key, tags).await
}
