//! Bookmarks IPC — list / add / remove / reorder.

use std::sync::Arc;

use crate::services::bookmarks::{Bookmark, BookmarksStore};
use crate::types::{DuetError, Location};

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_list(
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    Ok(store.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_add(
    name: String,
    location: Location,
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    store.add(name, location).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_remove(
    id: String,
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    store.remove(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn bookmarks_reorder(
    ids: Vec<String>,
    store: tauri::State<'_, Arc<BookmarksStore>>,
) -> Result<Vec<Bookmark>, DuetError> {
    store.reorder(ids).await
}
