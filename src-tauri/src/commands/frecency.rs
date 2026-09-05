//! Frecency IPC — navigate 기록(record) + 점퍼 조회(query).

use std::sync::Arc;

use crate::services::frecency::{FrecencyEntry, FrecencyStore};
use crate::types::{DuetError, Location};

/// 디렉토리 방문 기록 — navigate 성공 시 프론트가 호출. now 는 백엔드 주입.
#[tauri::command]
#[specta::specta]
pub async fn frecency_record(
    location: Location,
    // SSH 면 호스트 alias — 재접속해도 같은 항목으로 합쳐지고, 점퍼가 alias 로 다시 연다.
    host_alias: Option<String>,
    store: tauri::State<'_, Arc<FrecencyStore>>,
) -> Result<(), DuetError> {
    store
        .record(location, host_alias, chrono::Utc::now().timestamp_millis())
        .await
}

/// 부분문자열 질의 → frecency 상위 `limit` 개(점수 내림차순).
#[tauri::command]
#[specta::specta]
pub async fn frecency_query(
    query: String,
    limit: u32,
    store: tauri::State<'_, Arc<FrecencyStore>>,
) -> Result<Vec<FrecencyEntry>, DuetError> {
    Ok(store
        .query(
            &query,
            limit as usize,
            chrono::Utc::now().timestamp_millis(),
        )
        .await)
}
