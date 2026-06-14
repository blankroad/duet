//! 앱 런처 IPC — 목록 CRUD + 실행. 파일 브라우저 + 자주 실행하는 앱.

use std::path::PathBuf;
use std::sync::Arc;

use crate::services::app_launchers::{AppLauncher, AppLaunchersStore};
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn apps_list(
    store: tauri::State<'_, Arc<AppLaunchersStore>>,
) -> Result<Vec<AppLauncher>, DuetError> {
    Ok(store.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn apps_add(
    name: String,
    path: PathBuf,
    store: tauri::State<'_, Arc<AppLaunchersStore>>,
) -> Result<Vec<AppLauncher>, DuetError> {
    store.add(name, path).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_rename(
    id: String,
    name: String,
    store: tauri::State<'_, Arc<AppLaunchersStore>>,
) -> Result<Vec<AppLauncher>, DuetError> {
    store.rename(&id, name).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_remove(
    id: String,
    store: tauri::State<'_, Arc<AppLaunchersStore>>,
) -> Result<Vec<AppLauncher>, DuetError> {
    store.remove(&id).await
}

#[tauri::command]
#[specta::specta]
pub async fn apps_reorder(
    ids: Vec<String>,
    store: tauri::State<'_, Arc<AppLaunchersStore>>,
) -> Result<Vec<AppLauncher>, DuetError> {
    store.reorder(ids).await
}

/// 앱 실행 — 절대경로(인자 없음, 셸 미경유)로 OS 런처에 위임.
/// macOS `.app`/win `.exe`/linux 실행파일을 `opener::open` 으로 (open_path 와 동일 패턴).
#[tauri::command]
#[specta::specta]
pub async fn app_launch(path: PathBuf) -> Result<(), DuetError> {
    if !path.exists() {
        return Err(DuetError::Io(format!(
            "app not found (moved or uninstalled?): {}",
            path.display()
        )));
    }
    tokio::task::spawn_blocking(move || opener::open(&path))
        .await
        .map_err(|e| DuetError::Io(format!("launch task join: {e}")))?
        .map_err(|e| DuetError::Io(format!("launch failed: {e}")))
}
