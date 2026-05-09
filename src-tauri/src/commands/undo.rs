//! Undo IPC commands.

use std::sync::Arc;

use crate::core::undo::{execute_undo, UndoKind, UndoOutcome};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry};
use crate::services::journal_events::JournalChangedEvent;
use crate::types::DuetError;
use tauri_specta::Event;

#[tauri::command]
#[specta::specta]
pub async fn undo_last(
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<UndoOutcome, DuetError> {
    let entry = match journal.pop_undoable().await? {
        Some(e) => e,
        None => {
            return Ok(UndoOutcome {
                kind: UndoKind::Skipped,
                message: Some("Nothing to undo".into()),
                refreshed_locations: vec![],
            })
        }
    };
    let outcome = execute_undo(&entry, pool.inner()).await;
    let _ = JournalChangedEvent {
        entry,
        change: "undone".into(),
    }
    .emit(&app);
    Ok(outcome)
}

#[tauri::command]
#[specta::specta]
pub async fn undo_history(
    limit: u32,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<Vec<JournalEntry>, DuetError> {
    Ok(journal.history(limit as usize).await)
}
