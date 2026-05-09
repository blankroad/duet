//! UndoAction 디스패처 — Task 17 에서 구현.
//!
//! placeholder — `execute_undo` 함수만 시그니처 노출.

use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::JournalEntry;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UndoOutcome {
    pub kind: UndoKind,
    pub message: Option<String>,
    pub refreshed_locations: Vec<crate::types::Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UndoKind {
    Ok,
    Skipped,
    Irreversible,
    Error,
}

pub async fn execute_undo(_entry: &JournalEntry, _pool: &Arc<ConnectionPool>) -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Skipped,
        message: Some("undo dispatcher not yet implemented (Task 17)".into()),
        refreshed_locations: vec![],
    }
}
