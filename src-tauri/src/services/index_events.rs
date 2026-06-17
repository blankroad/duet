//! 전역 파일 인덱스 빌드 진행 이벤트.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

/// 전체 드라이브 인덱싱 진행 상황 — 프론트 "indexing… N" 표시용.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct IndexProgressEvent {
    /// 지금까지 인덱싱한 파일 수.
    pub indexed: u32,
    /// 완료 여부.
    pub done: bool,
}
