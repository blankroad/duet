//! Undo IPC commands.

use std::sync::Arc;

use crate::core::undo::{execute_redo, execute_undo, UndoKind, UndoOutcome};
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

/// 마지막으로 되돌린 작업을 다시 실행 (redo, LIFO — undo 의 역순).
///
/// 지원 범위는 `execute_redo` 참조 — 미지원 op 는 Skipped 로 안내만 하고
/// journal 상태는 그대로 둔다.
#[tauri::command]
#[specta::specta]
pub async fn redo_last(
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<UndoOutcome, DuetError> {
    let entry = match journal.peek_redoable().await? {
        Some(e) => e,
        None => {
            return Ok(UndoOutcome {
                kind: UndoKind::Skipped,
                message: Some("Nothing to redo".into()),
                refreshed_locations: vec![],
            })
        }
    };
    let outcome = execute_redo(&entry, pool.inner()).await;
    // 성공 시에만 undone 해제 — Skipped(미지원)/Error 는 상태 유지해 정보 보존.
    if matches!(outcome.kind, UndoKind::Ok) {
        journal.commit_redone(entry.id).await?;
        let _ = JournalChangedEvent {
            entry,
            change: "redone".into(),
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
