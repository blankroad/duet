//! 파괴적 작업 IPC commands. plan/execute 두 단계 (CLAUDE.md §3, §4 준수).
//!
//! 모든 _execute 함수는 success 시 `JournalChangedEvent { change: "push" }` emit —
//! 프론트 journal store 가 자동 동기화 (Ctrl+Z 가능 여부 등 갱신).

use std::sync::Arc;

use crate::core::ops::{self, CopyPlan, DeletePlan, MovePlan, OpCtx};
use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry, JournalId};
use crate::services::journal_events::JournalChangedEvent;
use crate::services::settings::SettingsStore;
use crate::types::{DeleteMode, DuetError, EntryRef, Location, SourceId};
use tauri_specta::Event;

/// SourceId → FileSystem 동적 디스패치.
async fn fs_for(
    source: &SourceId,
    pool: &Arc<ConnectionPool>,
) -> Result<Box<dyn FileSystem>, DuetError> {
    match source {
        SourceId::Local => Ok(Box::new(LocalFs::new())),
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            Ok(Box::new(SshFs::new(conn)))
        }
    }
}

fn ctx(
    settings: Arc<SettingsStore>,
    journal: Arc<Journal>,
    pool: Arc<ConnectionPool>,
    app: tauri::AppHandle,
) -> OpCtx {
    OpCtx {
        settings,
        journal,
        pool: Some(pool),
        app: Some(app),
    }
}

/// 새 JournalEntry 가 push 된 직후 호출 — JournalChangedEvent emit + id 반환.
fn emit_pushed(app: &tauri::AppHandle, entry: JournalEntry) -> JournalId {
    let id = entry.id;
    let _ = JournalChangedEvent {
        entry,
        change: "push".into(),
    }
    .emit(app);
    id
}

#[tauri::command]
#[specta::specta]
pub async fn fs_delete_plan(
    targets: Vec<EntryRef>,
    mode: DeleteMode,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<DeletePlan, DuetError> {
    let source = targets
        .first()
        .map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no targets".into()))?;
    let fs = fs_for(&source, pool.inner()).await?;
    ops::delete_plan(&*fs, targets, mode).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_delete_execute(
    plan: DeletePlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let fs = fs_for(&plan.source, pool.inner()).await?;
    let entry = ops::delete_execute(
        &*fs,
        plan,
        &ctx(
            settings.inner().clone(),
            journal.inner().clone(),
            pool.inner().clone(),
            app.clone(),
        ),
    )
    .await?;
    Ok(emit_pushed(&app, entry))
}

#[tauri::command]
#[specta::specta]
pub async fn fs_copy_plan(
    items: Vec<EntryRef>,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<CopyPlan, DuetError> {
    let src_source = items
        .first()
        .map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no items".into()))?;
    let src_fs = fs_for(&src_source, pool.inner()).await?;
    let dst_fs = fs_for(&dst.source, pool.inner()).await?;
    ops::copy_plan(&*src_fs, &*dst_fs, items, dst).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_copy_execute(
    plan: CopyPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let src_fs = fs_for(&plan.src_source, pool.inner()).await?;
    let dst_fs = fs_for(&plan.dst.source, pool.inner()).await?;
    let entry = ops::copy_execute(
        &*src_fs,
        &*dst_fs,
        plan,
        &ctx(
            settings.inner().clone(),
            journal.inner().clone(),
            pool.inner().clone(),
            app.clone(),
        ),
    )
    .await?;
    Ok(emit_pushed(&app, entry))
}

#[tauri::command]
#[specta::specta]
pub async fn fs_move_plan(
    items: Vec<EntryRef>,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<MovePlan, DuetError> {
    let src_source = items
        .first()
        .map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no items".into()))?;
    let src_fs = fs_for(&src_source, pool.inner()).await?;
    let dst_fs = fs_for(&dst.source, pool.inner()).await?;
    ops::move_plan(&*src_fs, &*dst_fs, items, dst).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_move_execute(
    plan: MovePlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let src_fs = fs_for(&plan.src_source, pool.inner()).await?;
    let dst_fs = fs_for(&plan.dst.source, pool.inner()).await?;
    let entry = ops::move_execute(
        &*src_fs,
        &*dst_fs,
        plan,
        &ctx(
            settings.inner().clone(),
            journal.inner().clone(),
            pool.inner().clone(),
            app.clone(),
        ),
    )
    .await?;
    Ok(emit_pushed(&app, entry))
}

#[tauri::command]
#[specta::specta]
pub async fn fs_rename(
    target: EntryRef,
    new_name: String,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let fs = fs_for(&target.location.source, pool.inner()).await?;
    let entry = ops::rename(
        &*fs,
        target,
        new_name,
        &ctx(
            settings.inner().clone(),
            journal.inner().clone(),
            pool.inner().clone(),
            app.clone(),
        ),
    )
    .await?;
    Ok(emit_pushed(&app, entry))
}

#[tauri::command]
#[specta::specta]
pub async fn fs_mkdir(
    parent: Location,
    name: String,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let fs = fs_for(&parent.source, pool.inner()).await?;
    let entry = ops::mkdir(
        &*fs,
        parent,
        name,
        &ctx(
            settings.inner().clone(),
            journal.inner().clone(),
            pool.inner().clone(),
            app.clone(),
        ),
    )
    .await?;
    Ok(emit_pushed(&app, entry))
}
