//! 시스템 정보 commands.

use crate::services::connection_pool::ConnectionPool;
use crate::types::{ConnectionId, DuetError};
use std::path::PathBuf;
use std::sync::Arc;

/// 사용자 home 디렉토리 절대경로.
///
/// Windows: `C:\Users\<name>`, Mac: `/Users/<name>`, Linux: `/home/<name>`.
/// 부트스트랩 시 양쪽 패널 초기 경로로 사용.
#[tauri::command]
#[specta::specta]
pub async fn home_directory() -> Result<PathBuf, DuetError> {
    dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))
}

/// 원격 SSH 호스트의 사용자 home 디렉토리 절대경로 (SFTP canonicalize ".").
///
/// 연결 직후 SSH 패널 시작 위치로 사용 — `/` 는 권한 없는 호스트 흔하므로
/// home 으로 바로 이동.
#[tauri::command]
#[specta::specta]
pub async fn ssh_home_directory(
    connection_id: ConnectionId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<PathBuf, DuetError> {
    let conn = pool.inner().get(&connection_id).await?;
    let fs = crate::fs::SshFs::new(conn);
    fs.home().await
}
