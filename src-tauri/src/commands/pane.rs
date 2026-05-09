//! 패널 관련 IPC commands.

use std::sync::Arc;

use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
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
