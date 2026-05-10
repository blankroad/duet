//! 파괴적 작업 IPC commands. plan/execute 두 단계 (CLAUDE.md §3, §4 준수).
//!
//! 모든 _execute 함수는 success 시 `JournalChangedEvent { change: "push" }` emit —
//! 프론트 journal store 가 자동 동기화 (Ctrl+Z 가능 여부 등 갱신).

use std::sync::Arc;

use crate::core::copy_strategy::{decide as decide_strategy, CopyStrategy};
use crate::core::ops::{self, CopyPlan, DeletePlan, MovePlan, OpCtx};
use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry, JournalId};
use crate::services::journal_events::JournalChangedEvent;
use crate::services::settings::SettingsStore;
use crate::services::task_events::{HostKey, TaskId, TaskKind};
use crate::services::task_queue::TaskQueue;
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
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&plan.src_source, &plan.dst.source);
    let title = format_copy_title(&plan);

    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();

    // refresh 할 location: dst + src (items[0].location)
    let mut affected = vec![plan.dst.clone()];
    if let Some(first) = plan.items.first() {
        affected.push(first.location.clone());
    }

    let plan_for_run = plan;

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Copy,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, progress| {
                Box::pin(async move {
                    let src_fs = fs_for(&plan_for_run.src_source, &pool_inner).await?;
                    let dst_fs = fs_for(&plan_for_run.dst.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry = ops::copy_execute(
                        &*src_fs,
                        &*dst_fs,
                        plan_for_run,
                        &ctx,
                        cancel_token,
                        Some(progress),
                    )
                    .await?;
                    Ok(emit_pushed(&app_for_run, entry))
                })
            }),
        )
        .await;
    Ok(task_id)
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
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&plan.src_source, &plan.dst.source);
    let title = format_move_title(&plan);

    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();

    // refresh 할 location: dst + src (items[0].location)
    let mut affected = vec![plan.dst.clone()];
    if let Some(first) = plan.items.first() {
        affected.push(first.location.clone());
    }

    let plan_for_run = plan;

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Move,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, progress| {
                Box::pin(async move {
                    let src_fs = fs_for(&plan_for_run.src_source, &pool_inner).await?;
                    let dst_fs = fs_for(&plan_for_run.dst.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry = ops::move_execute(
                        &*src_fs,
                        &*dst_fs,
                        plan_for_run,
                        &ctx,
                        cancel_token,
                        Some(progress),
                    )
                    .await?;
                    Ok(emit_pushed(&app_for_run, entry))
                })
            }),
        )
        .await;
    Ok(task_id)
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

/// src/dst SourceId 로부터 TaskQueue worker 키 결정.
/// SshSameHost 이면 해당 host IP 기준 Ssh 키, 그 외는 Local.
fn host_key_for_op(src: &SourceId, dst: &SourceId) -> HostKey {
    match decide_strategy(src, dst) {
        CopyStrategy::SshSameHost => match src {
            SourceId::Ssh { host_ip, .. } => HostKey::Ssh {
                host_ip: host_ip.to_string(),
            },
            // SshSameHost 이면 src 는 반드시 Ssh — unreachable
            _ => HostKey::Local,
        },
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => HostKey::Local,
    }
}

fn format_copy_title(plan: &CopyPlan) -> String {
    let n = plan.items.len();
    let first = plan.items.first().map(|i| i.name.as_str()).unwrap_or("?");
    let dst = plan.dst.path.display();
    if n == 1 {
        format!("Copying {first} → {dst}")
    } else {
        format!("Copying {first} and {} more → {dst}", n - 1)
    }
}

fn format_move_title(plan: &MovePlan) -> String {
    let n = plan.items.len();
    let first = plan.items.first().map(|i| i.name.as_str()).unwrap_or("?");
    let dst = plan.dst.path.display();
    if n == 1 {
        format!("Moving {first} → {dst}")
    } else {
        format!("Moving {first} and {} more → {dst}", n - 1)
    }
}
