//! Keymap 변경 이벤트 — 파일 watcher 가 변경 감지 시 emit.

use crate::services::keymap::KeymapBinding;
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct KeymapChangedEvent {
    pub bindings: Vec<KeymapBinding>,
}

/// 실행 중 keymap.toml 을 다시 읽다 실패 — 이전 키 설정을 그대로 쓴다는 알림용(ss-12).
/// 파일은 사용자가 편집 중일 수 있으므로 옮기지 않는다(시작 시 로드와 다름).
#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct KeymapLoadFailedEvent {
    /// 파싱 오류 원문(줄·열 포함).
    pub message: String,
}
