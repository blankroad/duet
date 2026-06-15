//! 파괴적 작업 IPC commands. plan/execute 두 단계 (CLAUDE.md §3, §4 준수).
//!
//! 모든 _execute 함수는 success 시 `JournalChangedEvent { change: "push" }` emit —
//! 프론트 journal store 가 자동 동기화 (Ctrl+Z 가능 여부 등 갱신).

use std::sync::Arc;

use crate::core::archive::{self, CompressFormat, CompressPlan, ExtractPlan};
use crate::core::copy_strategy::{decide as decide_strategy, CopyStrategy};
use crate::core::ops::{
    self, ApplyDecision, BatchRenamePlan, CopyPlan, DeletePlan, MovePlan, OpCtx, RenameRule,
    SyncPlan,
};
use crate::fs::{FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{Journal, JournalEntry, JournalId};
use crate::services::journal_events::JournalChangedEvent;
use crate::services::settings::SettingsStore;
use crate::services::task_events::{HostKey, TaskId, TaskKind};
use crate::services::task_queue::TaskQueue;
use crate::types::{
    DeleteMode, DuetError, EntryKind, EntryRef, Location, PreviewData, PreviewKind, SourceId,
};
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

/// OS(파인더/탐색기)에서 끌어온 로컬 절대경로들을 dst 로 복사하기 위한 plan.
///
/// 끌어온 경로는 항상 로컬 절대경로 — 각 경로를 (부모 디렉토리 Local Location + 파일명)
/// EntryRef 로 변환해 일반 copy_plan 재사용. 경로 분해는 Rust `Path` 로만 (CLAUDE.md §7).
#[tauri::command]
#[specta::specta]
pub async fn fs_copy_plan_external(
    paths: Vec<std::path::PathBuf>,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<CopyPlan, DuetError> {
    let mut items = Vec::with_capacity(paths.len());
    for p in &paths {
        let name = p
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| DuetError::Io(format!("invalid path: {}", p.display())))?
            .to_string();
        let parent = p
            .parent()
            .ok_or_else(|| DuetError::Io(format!("path has no parent: {}", p.display())))?
            .to_path_buf();
        items.push(EntryRef {
            location: Location {
                source: SourceId::Local,
                path: parent,
            },
            name,
        });
    }
    if items.is_empty() {
        return Err(DuetError::Io("no paths".into()));
    }
    let src_fs = fs_for(&SourceId::Local, pool.inner()).await?;
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

/// 활성 비교 스캔 토큰 — 새 비교 또는 cancel 시 이전 토큰 cancel (search 와 동일 패턴).
#[derive(Default)]
pub struct ActiveCompare {
    token: tokio::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
}

impl ActiveCompare {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    async fn rotate(&self) -> tokio_util::sync::CancellationToken {
        let mut guard = self.token.lock().await;
        if let Some(prev) = guard.take() {
            prev.cancel();
        }
        let new = tokio_util::sync::CancellationToken::new();
        *guard = Some(new.clone());
        new
    }
    async fn cancel_current(&self) {
        if let Some(tok) = self.token.lock().await.take() {
            tok.cancel();
        }
    }
}

/// 두 패널 디렉토리 재귀 비교 (folder diff) — 읽기 전용. cross-source OK.
/// 대형/원격 트리용: 진행률(CompareProgressEvent) emit + 취소(fs_compare_cancel).
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn fs_compare_dirs(
    left: Location,
    right: Location,
    rules: crate::core::compare::CompareRules,
    detect_renames: bool,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    active: tauri::State<'_, Arc<ActiveCompare>>,
    app: tauri::AppHandle,
) -> Result<crate::core::compare::ComparePlan, DuetError> {
    use crate::services::compare_events::CompareProgressEvent;
    let left_fs = fs_for(&left.source, pool.inner()).await?;
    let right_fs = fs_for(&right.source, pool.inner()).await?;
    let cancel = active.inner().rotate().await;

    // 진행률 emit 은 256 항목 단위로 throttle (이벤트 폭주 방지).
    let last_emit = std::sync::atomic::AtomicU64::new(0);
    let app_for_emit = app.clone();
    let on_progress = move |scanned: u64| {
        let prev = last_emit.load(std::sync::atomic::Ordering::Relaxed);
        if scanned >= prev + 256 {
            last_emit.store(scanned, std::sync::atomic::Ordering::Relaxed);
            let _ = CompareProgressEvent { scanned }.emit(&app_for_emit);
        }
    };
    let mut plan = crate::core::compare::compare_dirs_progress(
        &*left_fs,
        left,
        &*right_fs,
        right,
        &rules,
        &cancel,
        &on_progress,
    )
    .await?;
    if detect_renames {
        ops::detect_renames(&mut plan, &*left_fs, &*right_fs, Some(pool.inner())).await?;
    }
    Ok(plan)
}

/// 진행 중인 비교 스캔 취소.
#[tauri::command]
#[specta::specta]
pub async fn fs_compare_cancel(
    active: tauri::State<'_, Arc<ActiveCompare>>,
) -> Result<(), DuetError> {
    active.inner().cancel_current().await;
    Ok(())
}

/// 선택 rel 들의 내용 검증 (size+mtime 의 '틀린 Same' 잡기) — 읽기 전용.
/// same-host 는 host-side sha256(PC 다운로드 0), 그 외는 바이트 비교(64MB 이하).
#[tauri::command]
#[specta::specta]
pub async fn fs_compare_verify(
    left: Location,
    right: Location,
    rels: Vec<String>,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Vec<ops::VerifyResult>, DuetError> {
    let left_fs = fs_for(&left.source, pool.inner()).await?;
    let right_fs = fs_for(&right.source, pool.inner()).await?;
    ops::verify_compare(
        &*left_fs,
        &left,
        &*right_fs,
        &right,
        rels,
        Some(pool.inner()),
    )
    .await
}

/// 비교 결과 export 포맷.
#[derive(serde::Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Json,
}

/// 비교 결과를 로컬 파일(CSV/JSON)로 내보내기 — dest 는 로컬 절대경로(§1 backend write).
#[tauri::command]
#[specta::specta]
pub async fn fs_export_compare(
    plan: crate::core::compare::ComparePlan,
    dest: std::path::PathBuf,
    format: ExportFormat,
) -> Result<(), DuetError> {
    let text = crate::core::compare::export_plan(&plan, matches!(format, ExportFormat::Json))?;
    tokio::fs::write(&dest, text)
        .await
        .map_err(DuetError::from)?;
    Ok(())
}

/// 3-way 비교 (base 대비 left/right) — '추가 vs 삭제' 구별. 읽기 전용.
#[tauri::command]
#[specta::specta]
pub async fn fs_compare_three_way(
    base: Location,
    left: Location,
    right: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<crate::core::three_way::ThreeWayPlan, DuetError> {
    let base_fs = fs_for(&base.source, pool.inner()).await?;
    let left_fs = fs_for(&left.source, pool.inner()).await?;
    let right_fs = fs_for(&right.source, pool.inner()).await?;
    crate::core::three_way::compare_three_way(&*base_fs, base, &*left_fs, left, &*right_fs, right)
        .await
}

/// 원격 `~/.duet-trash` 누적 용량 조회 — 읽기 전용. 로컬은 available=false.
#[tauri::command]
#[specta::specta]
pub async fn fs_trash_usage(
    source: SourceId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<ops::TrashUsage, DuetError> {
    ops::trash_usage(&source, pool.inner()).await
}

/// 단방향 미러 dry-run — 복사/prune 목록(SyncDialog 가 사전 표시). 읽기 전용.
#[tauri::command]
#[specta::specta]
pub async fn fs_sync_preview(
    src: Location,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<ops::SyncPreview, DuetError> {
    let src_fs = fs_for(&src.source, pool.inner()).await?;
    let dst_fs = fs_for(&dst.source, pool.inner()).await?;
    ops::sync_preview(&*src_fs, &src, &*dst_fs, &dst, Some(pool.inner())).await
}

/// 단방향 미러 계획 — 활성 패널 dir(src) → 반대 패널 dir(dst). v1 local↔local 만.
#[tauri::command]
#[specta::specta]
pub async fn fs_sync_plan(
    src: Location,
    dst: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<SyncPlan, DuetError> {
    let src_fs = fs_for(&src.source, pool.inner()).await?;
    let dst_fs = fs_for(&dst.source, pool.inner()).await?;
    ops::sync_plan(&*src_fs, &*dst_fs, src, dst).await
}

/// 미러 실행 — Task 로 enqueue (진행률/취소). 추가 전용, UndoCopy 로 복원.
#[tauri::command]
#[specta::specta]
pub async fn fs_sync_execute(
    plan: SyncPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&plan.src.source, &plan.dst.source);
    let title = format!(
        "Syncing {} → {}",
        plan.src.path.display(),
        plan.dst.path.display()
    );
    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();
    let affected = vec![plan.dst.clone(), plan.src.clone()];
    let plan_for_run = plan;

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Sync,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, progress| {
                Box::pin(async move {
                    let src_fs = fs_for(&plan_for_run.src.source, &pool_inner).await?;
                    let dst_fs = fs_for(&plan_for_run.dst.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry = ops::sync_execute(
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

/// 양방향 머지 — 한쪽에만 있는 파일을 반대편으로 복사(양쪽). 충돌은 미변경.
/// Task 로 enqueue (진행률/취소), UndoBidirMerge 로 복원.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn fs_merge_bidir(
    left: Location,
    right: Location,
    detect_renames: bool,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&left.source, &right.source);
    let title = format!("Merging {} ↔ {}", left.path.display(), right.path.display());
    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();
    let affected = vec![left.clone(), right.clone()];
    let (left_for_run, right_for_run) = (left, right);

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Sync,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, progress| {
                Box::pin(async move {
                    let left_fs = fs_for(&left_for_run.source, &pool_inner).await?;
                    let right_fs = fs_for(&right_for_run.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry = ops::merge_bidir(
                        &*left_fs,
                        left_for_run,
                        &*right_fs,
                        right_for_run,
                        detect_renames,
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

/// 비교창에서 고른 행별 방향을 적용 — 생성 + 덮어쓰기(백업). Task 로 enqueue
/// (진행률/취소), UndoCompareApply 로 Ctrl+Z 한 번에 복원.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // IPC command — 입력 + tauri State 주입들.
pub async fn fs_apply_compare(
    left: Location,
    right: Location,
    decisions: Vec<ApplyDecision>,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&left.source, &right.source);
    let title = format!(
        "Applying {} ↔ {}",
        left.path.display(),
        right.path.display()
    );
    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();
    let affected = vec![left.clone(), right.clone()];
    let (left_for_run, right_for_run) = (left, right);

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Sync,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, progress| {
                Box::pin(async move {
                    let left_fs = fs_for(&left_for_run.source, &pool_inner).await?;
                    let right_fs = fs_for(&right_for_run.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry = ops::apply_compare(
                        &*left_fs,
                        left_for_run,
                        &*right_fs,
                        right_for_run,
                        decisions,
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

/// 일괄 이름변경 미리보기 — 변환 결과 + 충돌 플래그. 쓰기 없음.
#[tauri::command]
#[specta::specta]
pub async fn fs_batch_rename_preview(
    items: Vec<EntryRef>,
    rule: RenameRule,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<BatchRenamePlan, DuetError> {
    let source = items
        .first()
        .map(|it| it.location.source.clone())
        .ok_or_else(|| DuetError::Io("no targets".into()))?;
    let fs = fs_for(&source, pool.inner()).await?;
    ops::batch_rename_preview(&*fs, items, rule).await
}

/// 일괄 이름변경 실행 — 단일 journal 엔트리(한 번의 Ctrl+Z 로 전체 복원).
/// 충돌이 있으면 아무것도 바꾸지 않고 에러. TOCTOU 회피 위해 rule 로 재계산.
#[tauri::command]
#[specta::specta]
pub async fn fs_batch_rename(
    items: Vec<EntryRef>,
    rule: RenameRule,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let source = items
        .first()
        .map(|it| it.location.source.clone())
        .ok_or_else(|| DuetError::Io("no targets".into()))?;
    let fs = fs_for(&source, pool.inner()).await?;
    let entry = ops::batch_rename_execute(
        &*fs,
        items,
        rule,
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

// === Archive: Browse / Extract / Compress ===

/// 아카이브를 임시 위치로 풀고 그 디렉토리 Location 반환 — 패널이 탐색기처럼 내부 열람.
/// 로컬은 temp, 원격은 호스트사이드 추출(PC 경유 0). 비파괴라 journal 없음.
#[tauri::command]
#[specta::specta]
pub async fn fs_archive_open_for_browse(
    archive: EntryRef,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Location, DuetError> {
    let loc = archive::open_for_browse(archive, pool.inner()).await?;
    // 원격 browse 면 임시 루트(`~/.duet-tmp/browse-<token>` = stem 의 부모)를 연결에
    // 등록 — 연결 종료 시 reap (Phase 2). 등록 실패는 비치명적(reap 만 누락).
    if let SourceId::Ssh { connection_id, .. } = &loc.source {
        if let (Ok(conn), Some(root)) = (pool.get(connection_id).await, loc.path.parent()) {
            conn.track_browse_dir(root.to_path_buf()).await;
        }
    }
    Ok(loc)
}

#[tauri::command]
#[specta::specta]
pub async fn fs_extract_plan(
    archive: EntryRef,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<ExtractPlan, DuetError> {
    let fs = fs_for(&archive.location.source, pool.inner()).await?;
    archive::extract_plan(&*fs, archive).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_extract_execute(
    plan: ExtractPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&plan.source, &plan.source);
    let title = format!("Extracting {}", plan.archive_name);
    let affected = vec![plan.archive_dir.clone()];

    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();
    let plan_for_run = plan;

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Extract,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, _progress| {
                Box::pin(async move {
                    let fs = fs_for(&plan_for_run.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry =
                        archive::extract_execute(&*fs, plan_for_run, &ctx, cancel_token).await?;
                    Ok(emit_pushed(&app_for_run, entry))
                })
            }),
        )
        .await;
    Ok(task_id)
}

#[tauri::command]
#[specta::specta]
pub async fn fs_compress_plan(
    items: Vec<EntryRef>,
    archive_name: String,
    format: CompressFormat,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<CompressPlan, DuetError> {
    let source = items
        .first()
        .map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no items".into()))?;
    let fs = fs_for(&source, pool.inner()).await?;
    archive::compress_plan(&*fs, items, archive_name, format).await
}

/// 아카이브 browse 세션 → 원본 아카이브 재압축 계획 (Phase 3). 실행은 기존
/// `fs_compress_execute` 재사용 (원본은 .bak 백업 + UndoCopy 로 복원).
#[tauri::command]
#[specta::specta]
pub async fn fs_repack_plan(
    browse_root: Location,
    original_archive: EntryRef,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<CompressPlan, DuetError> {
    let fs = fs_for(&browse_root.source, pool.inner()).await?;
    archive::repack_plan(&*fs, browse_root, original_archive).await
}

#[tauri::command]
#[specta::specta]
pub async fn fs_compress_execute(
    plan: CompressPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    let host_key = host_key_for_op(&plan.source, &plan.source);
    let n = plan.item_names.len();
    let title = if n == 1 {
        format!("Compressing {}", plan.item_names[0])
    } else {
        format!("Compressing {n} items")
    };
    let affected = vec![plan.src_dir.clone()];

    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();
    let plan_for_run = plan;

    let task_id = queue
        .inner()
        .clone()
        .enqueue(
            TaskKind::Compress,
            title,
            host_key,
            affected,
            Box::new(move |cancel_token, _progress| {
                Box::pin(async move {
                    let fs = fs_for(&plan_for_run.source, &pool_inner).await?;
                    let ctx = OpCtx {
                        settings: settings_inner,
                        journal: journal_inner.clone(),
                        pool: Some(pool_inner.clone()),
                        app: Some(app_for_run.clone()),
                    };
                    let entry =
                        archive::compress_execute(&*fs, plan_for_run, &ctx, cancel_token).await?;
                    Ok(emit_pushed(&app_for_run, entry))
                })
            }),
        )
        .await;
    Ok(task_id)
}

/// 텍스트 미리보기 최대 크기 (256 KB). 초과 시 `TooLarge`.
const PREVIEW_TEXT_CAP: u64 = 256 * 1024;
/// 이미지 미리보기 최대 크기 (5 MB). 초과 시 `TooLarge` — SSH 왕복/메모리 보호.
const PREVIEW_IMAGE_CAP: u64 = 5 * 1024 * 1024;

/// 확장자 → 스트리밍 대상(PDF/오디오/비디오)이면 (PreviewKind, MIME). 아니면 None.
/// 이 종류는 바이트를 IPC 로 싣지 않고 `duet-preview://` 프로토콜로 스트리밍한다.
fn stream_media(path: &std::path::Path) -> Option<(PreviewKind, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "pdf" => (PreviewKind::Pdf, "application/pdf"),
        "mp4" | "m4v" => (PreviewKind::Video, "video/mp4"),
        "webm" => (PreviewKind::Video, "video/webm"),
        "mov" => (PreviewKind::Video, "video/quicktime"),
        "mkv" => (PreviewKind::Video, "video/x-matroska"),
        "mp3" => (PreviewKind::Audio, "audio/mpeg"),
        "m4a" | "aac" => (PreviewKind::Audio, "audio/aac"),
        "wav" => (PreviewKind::Audio, "audio/wav"),
        "ogg" | "oga" => (PreviewKind::Audio, "audio/ogg"),
        "opus" => (PreviewKind::Audio, "audio/opus"),
        "flac" => (PreviewKind::Audio, "audio/flac"),
        _ => return None,
    })
}

/// 확장자 → 이미지 MIME. 이미지가 아니면 None.
fn image_mime(path: &std::path::Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

/// 표준 base64 인코더 (의존성 회피 — 자기완결). 패딩 포함.
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 파일 미리보기 1건 읽기 — 미리보기 패널용.
///
/// 이미지(확장자 판정)는 base64 + MIME, 그 외는 utf8 디코드 시도해서 Text/Binary.
/// cap 초과는 `TooLarge` 로 반환(에러 아님 — 패널이 메타만 표시).
/// 디렉토리/심볼릭 등 파일이 아니면 에러.
#[tauri::command]
#[specta::specta]
pub async fn fs_read_preview(
    location: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<PreviewData, DuetError> {
    let fs = fs_for(&location.source, pool.inner()).await?;
    build_preview(&*fs, &location.path).await
}

/// 단일 파일의 미리보기 데이터 구성 (fs_read_preview / pair-preview 공용).
async fn build_preview(
    fs: &dyn FileSystem,
    path: &std::path::Path,
) -> Result<PreviewData, DuetError> {
    let meta = fs.metadata(path).await?;
    if meta.kind != EntryKind::File {
        return Err(DuetError::Io("not a regular file".into()));
    }
    let total_size = meta.size.unwrap_or(0);

    // PDF/오디오/비디오: 바이트를 IPC 로 안 싣고 duet-preview:// 로 스트리밍.
    if let Some((kind, mime)) = stream_media(path) {
        return Ok(PreviewData {
            kind,
            text: None,
            bytes_base64: None,
            mime: Some(mime.to_string()),
            truncated: false,
            total_size,
        });
    }

    // 이미지: 부분 렌더 불가 → cap 초과 시 TooLarge, 아니면 전체 읽어 base64.
    if let Some(mime) = image_mime(path) {
        if total_size > PREVIEW_IMAGE_CAP {
            return Ok(too_large(total_size));
        }
        let bytes = fs.read_full(path).await?;
        return Ok(PreviewData {
            kind: PreviewKind::Image,
            text: None,
            bytes_base64: Some(base64_encode(&bytes)),
            mime: Some(mime.to_string()),
            truncated: false,
            total_size,
        });
    }

    // 텍스트/바이너리: cap 이하는 전체, 초과는 head 만 읽어 truncated 표시.
    if total_size <= PREVIEW_TEXT_CAP {
        let bytes = fs.read_full(path).await?;
        Ok(decode_text(&bytes, false, total_size))
    } else {
        let (head, _had_more) = fs.read_head(path, PREVIEW_TEXT_CAP as usize).await?;
        Ok(decode_text(&head, true, total_size))
    }
}

/// 비교 한 행(rel)의 좌/우 미리보기 쌍 — 인라인 diff 용. 경로 결합은 backend(§7).
#[derive(serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ComparePairPreview {
    pub left: PreviewData,
    pub right: PreviewData,
}

/// 비교 한 행의 좌/우 미리보기를 함께 반환 (rel 을 backend 에서 양쪽 루트에 join).
/// rel 은 비교 결과의 상대경로 — `..` 컴포넌트는 거부(경로 이탈 방지).
#[tauri::command]
#[specta::specta]
pub async fn fs_compare_pair_preview(
    left: Location,
    right: Location,
    rel: String,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<ComparePairPreview, DuetError> {
    let rel_path = std::path::Path::new(&rel);
    if rel_path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(DuetError::Io("invalid rel (.. not allowed)".into()));
    }
    let lp = left.path.join(rel_path);
    let rp = right.path.join(rel_path);
    let left_fs = fs_for(&left.source, pool.inner()).await?;
    let right_fs = fs_for(&right.source, pool.inner()).await?;
    Ok(ComparePairPreview {
        left: build_preview(&*left_fs, &lp).await?,
        right: build_preview(&*right_fs, &rp).await?,
    })
}

/// TooLarge 미리보기 결과 (이미지 전용).
fn too_large(total_size: u64) -> PreviewData {
    PreviewData {
        kind: PreviewKind::TooLarge,
        text: None,
        bytes_base64: None,
        mime: None,
        truncated: false,
        total_size,
    }
}

/// Binary 미리보기 결과.
fn binary_preview(total_size: u64) -> PreviewData {
    PreviewData {
        kind: PreviewKind::Binary,
        text: None,
        bytes_base64: None,
        mime: None,
        truncated: false,
        total_size,
    }
}

/// 바이너리 휴리스틱 — NUL 바이트(SQLite 등 텍스트 헤더 가진 바이너리)나
/// 비텍스트 제어문자 비율이 높으면 true. 빈 입력은 false(빈 텍스트로 표시).
fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    // 실제 텍스트 파일엔 NUL 이 거의 없음 — 강한 신호.
    if bytes.contains(&0) {
        return true;
    }
    // \t\n\r 외 C0 제어문자 비율이 과하면 바이너리.
    let sample = &bytes[..bytes.len().min(8192)];
    let ctrl = sample
        .iter()
        .filter(|&&b| b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r')
        .count();
    ctrl * 100 / sample.len() > 30
}

/// 바이트를 텍스트로 디코드 — 유효 UTF-8 prefix 만 사용(head 절단 시 멀티바이트
/// 경계 보호). 바이너리(NUL/제어문자 과다)거나 prefix 가 비면 Binary.
fn decode_text(bytes: &[u8], truncated: bool, total_size: u64) -> PreviewData {
    if looks_binary(bytes) {
        return binary_preview(total_size);
    }
    let valid_len = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => e.valid_up_to(),
    };
    if valid_len == 0 && !bytes.is_empty() {
        return binary_preview(total_size);
    }
    // valid_len 까지는 유효 UTF-8 보장.
    let text = String::from_utf8_lossy(&bytes[..valid_len]).into_owned();
    PreviewData {
        kind: PreviewKind::Text,
        text: Some(text),
        bytes_base64: None,
        mime: None,
        truncated,
        total_size,
    }
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

#[cfg(test)]
mod preview_tests {
    use super::{base64_encode, decode_text, image_mime};
    use crate::types::PreviewKind;
    use std::path::Path;

    #[test]
    fn decode_text_plain_utf8() {
        let d = decode_text(b"hello", false, 5);
        assert_eq!(d.kind, PreviewKind::Text);
        assert_eq!(d.text.as_deref(), Some("hello"));
        assert!(!d.truncated);
    }

    #[test]
    fn decode_text_truncated_flag() {
        let d = decode_text(b"partial", true, 9999);
        assert_eq!(d.kind, PreviewKind::Text);
        assert!(d.truncated);
    }

    #[test]
    fn decode_text_cut_multibyte_keeps_valid_prefix() {
        // "a€" = 61 E2 82 AC. head 가 멀티바이트 중간(61 E2)에서 잘린 경우.
        let d = decode_text(&[0x61, 0xE2], true, 4);
        assert_eq!(d.kind, PreviewKind::Text);
        assert_eq!(d.text.as_deref(), Some("a"));
    }

    #[test]
    fn decode_text_binary_when_no_valid_prefix() {
        let d = decode_text(&[0xFF, 0xFE, 0x00], false, 3);
        assert_eq!(d.kind, PreviewKind::Binary);
        assert!(d.text.is_none());
    }

    #[test]
    fn decode_text_sqlite_header_is_binary() {
        // "SQLite format 3\0" — 앞부분 ASCII 라 prefix 로는 텍스트로 오인되던 케이스.
        let mut bytes = b"SQLite format 3\0".to_vec();
        bytes.extend_from_slice(&[0x10, 0x00, 0x00, 0x01, 0x00, 0x40]);
        let d = decode_text(&bytes, false, 4096);
        assert_eq!(d.kind, PreviewKind::Binary);
        assert!(d.text.is_none());
    }

    #[test]
    fn decode_text_plain_with_newlines_stays_text() {
        let d = decode_text(b"line1\nline2\ttab\r\n", false, 17);
        assert_eq!(d.kind, PreviewKind::Text);
    }

    #[test]
    fn image_mime_includes_avif() {
        assert_eq!(image_mime(Path::new("a.avif")), Some("image/avif"));
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn image_mime_by_extension() {
        assert_eq!(image_mime(Path::new("a.png")), Some("image/png"));
        assert_eq!(image_mime(Path::new("a.JPG")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("a.svg")), Some("image/svg+xml"));
        assert_eq!(image_mime(Path::new("notes.txt")), None);
        assert_eq!(image_mime(Path::new("noext")), None);
    }
}
