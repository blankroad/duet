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
    let entry = match journal.peek_undoable().await? {
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
    // 성공(Ok) 또는 비가역 종결(Irreversible — 재시도 무의미)일 때만 undone 확정.
    // Error 면 엔트리를 남겨 다음 undo 시 재시도 가능 — 실행 실패로 인한 영구 손실 방지.
    if matches!(outcome.kind, UndoKind::Ok | UndoKind::Irreversible) {
        journal.commit_undone(entry.id).await?;
        let _ = JournalChangedEvent {
            entry,
            change: "undone".into(),
        }
        .emit(&app);
    }
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
