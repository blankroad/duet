//! 시스템 정보 commands.

use crate::types::DuetError;
use std::path::PathBuf;

/// 사용자 home 디렉토리 절대경로.
///
/// Windows: `C:\Users\<name>`, Mac: `/Users/<name>`, Linux: `/home/<name>`.
/// 부트스트랩 시 양쪽 패널 초기 경로로 사용.
#[tauri::command]
#[specta::specta]
pub async fn home_directory() -> Result<PathBuf, DuetError> {
    dirs::home_dir().ok_or_else(|| DuetError::Io("home directory not found".into()))
}
