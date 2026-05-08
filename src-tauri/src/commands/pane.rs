//! 패널 관련 IPC commands.

use crate::fs::{FileSystem, LocalFs};
use crate::types::{DuetError, Entry, Location, SourceId};

/// 디렉토리 항목 나열.
///
/// MVP-0에서는 로컬만 지원. MVP-1에서 SSH 라우팅 추가.
#[tauri::command]
#[specta::specta]
pub async fn list_directory(location: Location) -> Result<Vec<Entry>, DuetError> {
    match &location.source {
        SourceId::Local => {
            let fs = LocalFs::new();
            fs.list(&location.path).await
        }
        SourceId::Ssh { .. } => Err(DuetError::ConnectionFailed(
            "SSH는 MVP-1에서 지원".to_string(),
        )),
    }
}
