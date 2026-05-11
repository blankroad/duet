//! Keymap 변경 이벤트 — 파일 watcher 가 변경 감지 시 emit.

use crate::services::keymap::KeymapBinding;
use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Type, Event)]
pub struct KeymapChangedEvent {
    pub bindings: Vec<KeymapBinding>,
}
