//! Undo IPC commands.

use std::sync::Arc;

use crate::core::undo::{execute_redo, execute_undo, nothing, UndoKind, UndoOutcome, UndoReason};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry};
use crate::services::journal_events::JournalChangedEvent;
use crate::types::DuetError;
use tauri_specta::Event;

/// 결과 분류에 따라 journal 을 갱신하고, 바뀐 entry 와 변경 종류를 돌려준다(이벤트용).
///
/// - `on_commit` 대상 kind → `commit` 실행 + `commit_change` 이벤트.
/// - `Stale` → 메모리 stale 표시 + `"stale"` 이벤트 (다음 undo/redo 는 이 entry 를 건너뛴다).
/// - 그 외(`Error` 일시 오류, `Skipped`) → 그대로 (재시도 가능 / 할 일 없음).
async fn settle(
    journal: &Journal,
    entry: &JournalEntry,
    outcome: &UndoOutcome,
    is_undo: bool,
) -> Result<Option<&'static str>, DuetError> {
    let commit = if is_undo {
        // Partial: 남은 항목은 영구 사유(바뀜·사라짐·점유)라 재시도해도 같다 — 확정해야 스택이 진행.
        matches!(
            outcome.kind,
            UndoKind::Ok | UndoKind::Partial | UndoKind::Irreversible
        )
    } else {
        matches!(outcome.kind, UndoKind::Ok | UndoKind::Partial)
    };
    if commit {
        if is_undo {
            journal.commit_undone(entry.id).await?;
            return Ok(Some("undone"));
        }
        journal.commit_redone(entry.id).await?;
        return Ok(Some("redone"));
    }
    if matches!(outcome.kind, UndoKind::Stale) && journal.mark_stale(entry.id).await {
        return Ok(Some("stale"));
    }
    Ok(None)
}

/// undo/redo 공통 — 실행, journal 확정, 이벤트, 결과에 op 채우기.
async fn run(
    journal: &Journal,
    app: &tauri::AppHandle,
    entry: JournalEntry,
    mut outcome: UndoOutcome,
    is_undo: bool,
) -> Result<UndoOutcome, DuetError> {
    if let Some(change) = settle(journal, &entry, &outcome, is_undo).await? {
        let mut entry = entry.clone();
        entry.undone = match change {
            "undone" => true,
            "redone" => false,
            _ => entry.undone,
        };
        entry.stale = change == "stale" || entry.stale;
        let _ = JournalChangedEvent {
            entry,
            change: change.into(),
        }
        .emit(app);
    }
    outcome.op = Some(entry.op);
    Ok(outcome)
}

/// 가장 최근의 되돌릴 수 있는 작업을 되돌린다. 결과 분류는 `core::undo` 모듈 doc 참조.
#[tauri::command]
#[specta::specta]
pub async fn undo_last(
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<UndoOutcome, DuetError> {
    let Some(entry) = journal.peek_undoable().await? else {
        return Ok(nothing(UndoReason::NothingToUndo));
    };
    let outcome = execute_undo(&entry, pool.inner()).await;
    run(&journal, &app, entry, outcome, true).await
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
    let Some(entry) = journal.peek_redoable().await? else {
        return Ok(nothing(UndoReason::NothingToRedo));
    };
    let outcome = execute_redo(&entry, pool.inner()).await;
    run(&journal, &app, entry, outcome, false).await
}

#[tauri::command]
#[specta::specta]
pub async fn undo_history(
    limit: u32,
    journal: tauri::State<'_, Arc<Journal>>,
) -> Result<Vec<JournalEntry>, DuetError> {
    Ok(journal.history(limit as usize).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::undo::{stale, Step, Tally};
    use crate::services::journal::{OpKind, UndoAction};
    use crate::types::{Location, SourceId};
    use std::path::{Path, PathBuf};

    fn op() -> OpKind {
        OpKind::Trash {
            count: 1,
            location: Location {
                source: SourceId::Local,
                path: PathBuf::from("/fixture"),
            },
        }
    }

    async fn journal_with_two() -> (tempfile::TempDir, Arc<Journal>, JournalEntry, JournalEntry) {
        let dir = tempfile::tempdir().unwrap();
        let j = Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        let a = j.push(op(), UndoAction::Irreversible).await.unwrap();
        let b = j.push(op(), UndoAction::Irreversible).await.unwrap();
        (dir, j, a, b)
    }

    /// U-11/fileops-06: 더 이상 되돌릴 수 없는 맨 위 항목이 스택을 영원히 막지 않는다.
    #[tokio::test]
    async fn stale_top_entry_no_longer_blocks_previous_undo() {
        let (_d, j, a, b) = journal_with_two().await;
        let out = stale(UndoReason::Gone, Path::new("/fixture/x"));
        assert_eq!(settle(&j, &b, &out, true).await.unwrap(), Some("stale"));
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
    }

    /// fileops-22: 일부만 되돌린 결과는 확정된다 — 같은 항목에서 다시 멈추지 않는다.
    #[tokio::test]
    async fn partial_undo_is_committed() {
        let (_d, j, a, b) = journal_with_two().await;
        let mut t = Tally::default();
        t.record(Step::Done, &SourceId::Local, Path::new("/fixture/a"));
        t.record(
            Step::Skip(UndoReason::Gone),
            &SourceId::Local,
            Path::new("/fixture/b"),
        );
        let out = t.finish();
        assert_eq!(out.kind, UndoKind::Partial);
        assert_eq!(settle(&j, &b, &out, true).await.unwrap(), Some("undone"));
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, a.id);
    }

    /// 일시 오류는 그대로 남겨 재시도할 수 있다.
    #[tokio::test]
    async fn transient_error_keeps_entry_for_retry() {
        let (_d, j, _a, b) = journal_with_two().await;
        let out = crate::core::undo::error("x", DuetError::ConnectionFailed("down".into()));
        assert_eq!(out.reason, Some(UndoReason::Unreachable));
        assert_eq!(settle(&j, &b, &out, true).await.unwrap(), None);
        assert_eq!(j.peek_undoable().await.unwrap().unwrap().id, b.id);
    }

    /// redo 가 stale 이면 그 항목을 건너뛰고 다음 redo 후보로 넘어간다.
    #[tokio::test]
    async fn stale_redo_moves_on() {
        let (_d, j, a, b) = journal_with_two().await;
        j.commit_undone(b.id).await.unwrap();
        j.commit_undone(a.id).await.unwrap();
        assert_eq!(j.peek_redoable().await.unwrap().unwrap().id, a.id);
        let out = stale(UndoReason::Occupied, Path::new("/fixture/a"));
        assert_eq!(settle(&j, &a, &out, false).await.unwrap(), Some("stale"));
        assert_eq!(j.peek_redoable().await.unwrap().unwrap().id, b.id);
    }
}
