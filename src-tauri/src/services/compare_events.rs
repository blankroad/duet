//! 폴더 비교 스캔 진행률 이벤트.
//!
//! 대형/원격 트리 비교 중 누적 스캔 항목 수를 프론트로 흘려 보낸다(스캔 다이얼로그
//! 표시 + 취소 UI). 비교는 읽기 전용이라 journal/TaskQueue 와 무관.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct CompareProgressEvent {
    /// 지금까지 스캔(분류)한 누적 항목 수.
    pub scanned: u64,
}
