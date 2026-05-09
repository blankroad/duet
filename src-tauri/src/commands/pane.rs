//! 패널 관련 IPC commands.

use std::sync::Arc;

use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::fs_watcher::FsWatcher;
use crate::types::{DuetError, Entry, Location, SourceId};

/// 디렉토리 항목 나열.
///
/// `Location.source` 에 따라 라우팅:
/// - `SourceId::Local` → `LocalFs`
/// - `SourceId::Ssh { connection_id, .. }` → `ConnectionPool` 에서 활성 연결
///   가져와서 `SshFs`. 연결이 풀에 없으면 `ConnectionFailed`.
#[tauri::command]
#[specta::specta]
pub async fn list_directory(
    location: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Vec<Entry>, DuetError> {
    match &location.source {
        SourceId::Local => {
            let fs = LocalFs::new();
            fs.list(&location.path).await
        }
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            let fs = SshFs::new(conn);
            fs.list(&location.path).await
        }
    }
}

/// 패널이 보고 있는 location 갱신을 watcher 에 통지.
///
/// 프론트엔드는 navigate 직후 이 command 를 호출. backend 가 해당 패널의
/// 이전 watch 를 해제하고 새 path 에 대해:
/// - Local: `notify` 로 즉시 변경 감지
/// - SSH: 3초 간격으로 mtime 폴링
///
/// `location` 이 `None` 이면 watch 해제만 (패널 닫힘 등).
#[tauri::command]
#[specta::specta]
pub async fn pane_watch_set(
    pane_id: String,
    location: Option<Location>,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    watcher: tauri::State<'_, Arc<FsWatcher>>,
    app: tauri::AppHandle,
) -> Result<(), DuetError> {
    let watcher = watcher.inner().clone();
    let pool = pool.inner().clone();
    watcher
        .set_pane_location(pane_id, location, app, pool)
        .await;
    Ok(())
}
