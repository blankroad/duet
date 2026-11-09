//! Journal 변경 이벤트.

use crate::services::journal::JournalEntry;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct JournalChangedEvent {
    pub entry: JournalEntry,
    /// "push" | "undone" | "redone" | "stale" (stale = 더 이상 undo/redo 불가로 건너뜀, 메모리 전용)
    pub change: String,
}
