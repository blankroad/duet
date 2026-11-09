//! 시작 알림 IPC — 저장 파일 복구 내역을 프론트가 한 번 가져간다.

use crate::services::startup_notices::{StartupNotice, StartupNotices};
use crate::types::DuetError;

/// 시작할 때 고치고 넘어간 저장 파일 문제를 꺼낸다(꺼내면 비워짐).
#[tauri::command]
#[specta::specta]
pub fn startup_notices_take(
    state: tauri::State<'_, StartupNotices>,
) -> Result<Vec<StartupNotice>, DuetError> {
    Ok(state.inner().take())
}
