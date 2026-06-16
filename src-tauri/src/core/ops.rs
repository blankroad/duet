//! 파괴적 작업 추상화 — plan + execute 두 단계.
//!
//! plan() 결과는 IPC 노출 — UI 다이얼로그가 사용자에게 보여줌.
//! execute() 는 백엔드에서 settings/journal 갱신.

use crate::core::copy_strategy::{decide as decide_strategy, CopyStrategy};
use crate::fs::FileSystem;
use crate::services::journal::{
    BackupRestore, Journal, JournalEntry, MoveItem, OpKind, RenamePair, TrashItem, UndoAction,
};
use crate::services::settings::SettingsStore;
use crate::types::{DeleteMode, DuetError, EntryRef, Location, SourceId, TrashLocation};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;

/// op 실행 컨텍스트. 명시적 의존성 주입.
pub struct OpCtx {
    pub journal: Arc<Journal>,
    pub settings: Arc<SettingsStore>,
    /// MVP-3 same-host copy 가 SSH session 접근에 필요. Local-only op 는 None.
    pub pool: Option<Arc<crate::services::connection_pool::ConnectionPool>>,
    /// MVP-3 progress emit 에 필요. Local-only op 는 None.
    pub app: Option<tauri::AppHandle>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DeletePlan {
    pub mode: DeleteMode,
    pub targets: Vec<EntryRef>,
    pub total_size_bytes: u64,
    pub total_count: u32,
    /// targets 의 location.source — 모든 target 이 같은 source 가정 (UI 가 강제).
    pub source: SourceId,
    pub source_location: Location,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CopyPlan {
    pub src_source: SourceId,
    pub dst: Location,
    pub items: Vec<EntryRef>,
    pub conflicts: Vec<Conflict>,
    pub total_size_bytes: u64,
    /// MVP-3: 어느 경로로 복사할지 — UI 가 confirm dialog 에 표시.
    pub strategy: CopyStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MovePlan {
    pub src_source: SourceId,
    pub dst: Location,
    pub items: Vec<EntryRef>,
    pub conflicts: Vec<Conflict>,
    /// true 면 단순 rename (같은 fs). false 면 copy + trash.
    pub is_same_fs: bool,
    pub total_size_bytes: u64,
    /// MVP-3: 어느 경로로 복사할지 — UI 가 confirm dialog 에 표시.
    /// (execute 분기는 Task 7 에서 추가 예정.)
    pub strategy: CopyStrategy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Conflict {
    pub name: String,
    pub dst_path: PathBuf,
    pub will_become_backup: PathBuf,
}

/// `name` → `name.bak.<ts>`. timestamp 충돌 시 .<n> suffix 는 호출자가 retry.
pub fn backup_name(original: &str) -> String {
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    format!("{original}.bak.{ts}")
}

// === Delete ===

pub async fn delete_plan(
    fs: &dyn FileSystem,
    targets: Vec<EntryRef>,
    mode: DeleteMode,
) -> Result<DeletePlan, DuetError> {
    if targets.is_empty() {
        return Err(DuetError::Io("no targets".into()));
    }
    let source = targets[0].location.source.clone();
    let source_location = targets[0].location.clone();
    for t in &targets {
        if t.location.source != source {
            return Err(DuetError::Io("targets must share source".into()));
        }
    }
    let mut total_size_bytes = 0u64;
    for t in &targets {
        let p = t.location.path.join(&t.name);
        if let Ok(m) = fs.metadata(&p).await {
            total_size_bytes += m.size.unwrap_or(0);
        }
    }
    let total_count = targets.len() as u32;
    Ok(DeletePlan {
        mode,
        targets,
        total_size_bytes,
        total_count,
        source,
        source_location,
    })
}

/// 영구삭제 확인 단어 — 사용자가 DangerConfirm 다이얼로그에 타이핑해야 하는 값.
pub const PERMANENT_DELETE_CONFIRM_WORD: &str = "delete";

pub async fn delete_execute(
    fs: &dyn FileSystem,
    plan: DeletePlan,
    ctx: &OpCtx,
    confirm_word: &str,
) -> Result<JournalEntry, DuetError> {
    if matches!(plan.mode, DeleteMode::Permanent) {
        let s = ctx.settings.get().await;
        if !s.permanent_delete_enabled {
            return Err(DuetError::NotPermitted);
        }
        // §3: 영구삭제는 단어-타이핑 확인을 백엔드에서 강제 (프론트-전용 게이트 아님).
        // command 직접 호출 시에도 확인 단어 없이는 비가역 삭제 불가.
        if confirm_word != PERMANENT_DELETE_CONFIRM_WORD {
            return Err(DuetError::NotPermitted);
        }
    }

    // §4: 항목별로 진행하며 누적하고, 중간 실패 시에도 '여기까지'를 journal 에 기록한 뒤
    // 에러를 전파한다. 그래야 이미 휴지통으로 옮겨진 1..N-1 항목을 Ctrl+Z 로 복원할 수 있다.
    match plan.mode {
        DeleteMode::Trash => {
            let batch_id = crate::services::trash::new_batch_id();
            let mut items = Vec::new();
            let mut outcome: Result<(), DuetError> = Ok(());
            for t in &plan.targets {
                let p = t.location.path.join(&t.name);
                match fs.trash(&p, &batch_id).await {
                    Ok(loc) => {
                        let trash_path = match &loc {
                            TrashLocation::Local { trash_id } => trash_id.clone(),
                            TrashLocation::Remote { trash_path } => {
                                trash_path.to_string_lossy().into_owned()
                            }
                        };
                        items.push(TrashItem {
                            trash_path,
                            original_path: p,
                        });
                    }
                    Err(e) => {
                        outcome = Err(e);
                        break;
                    }
                }
            }
            if items.is_empty() {
                // 아무 것도 휴지통으로 못 옮김 — 복원할 게 없으니 phantom 엔트리 안 남김.
                outcome?;
                return Err(DuetError::Io("delete affected nothing".into()));
            }
            let op = OpKind::Trash {
                count: items.len() as u32,
                location: plan.source_location.clone(),
            };
            let undo = UndoAction::RestoreFromTrash {
                source: plan.source.clone(),
                items,
            };
            let entry = ctx.journal.push(op, undo).await?;
            outcome?;
            Ok(entry)
        }
        DeleteMode::Permanent => {
            let mut removed = 0u32;
            let mut outcome: Result<(), DuetError> = Ok(());
            for t in &plan.targets {
                let p = t.location.path.join(&t.name);
                match fs.remove(&p).await {
                    Ok(()) => removed += 1,
                    Err(e) => {
                        outcome = Err(e);
                        break;
                    }
                }
            }
            if removed == 0 {
                outcome?;
                return Err(DuetError::Io("delete affected nothing".into()));
            }
            // 영구삭제는 undo 불가(Irreversible) — push 는 audit log 성격(실제 삭제 개수 기록).
            let op = OpKind::PermanentDelete {
                count: removed,
                location: plan.source_location.clone(),
            };
            let entry = ctx.journal.push(op, UndoAction::Irreversible).await?;
            outcome?;
            Ok(entry)
        }
    }
}

// === Copy ===

pub async fn copy_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
) -> Result<CopyPlan, DuetError> {
    if items.is_empty() {
        return Err(DuetError::Io("no items".into()));
    }
    let src_source = items[0].location.source.clone();
    for t in &items {
        if t.location.source != src_source {
            return Err(DuetError::Io("items must share source".into()));
        }
    }

    let mut conflicts = Vec::new();
    let mut total = 0u64;
    for it in &items {
        let dst_path = dst.path.join(&it.name);
        if dst_fs.metadata(&dst_path).await.is_ok() {
            conflicts.push(Conflict {
                name: it.name.clone(),
                dst_path: dst_path.clone(),
                will_become_backup: dst.path.join(backup_name(&it.name)),
            });
        }
        let src_path = it.location.path.join(&it.name);
        if let Ok(m) = src_fs.metadata(&src_path).await {
            total += m.size.unwrap_or(0);
        }
    }

    let strategy = decide_strategy(&src_source, &dst.source);
    Ok(CopyPlan {
        src_source,
        dst,
        items,
        conflicts,
        total_size_bytes: total,
        strategy,
    })
}

pub async fn copy_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    match plan.strategy {
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => {
            copy_execute_relay(src_fs, dst_fs, plan, ctx, cancel_token, progress).await
        }
        CopyStrategy::SshSameHost => {
            copy_execute_same_host(plan, ctx, cancel_token, progress).await
        }
    }
}

/// 기존 relay 경로 (LocalToLocal + Relay 공통).
/// 충돌 시 dst 파일을 .bak.<ts> 로 mv 후 src 를 복사. 파일은 chunk 스트리밍이라
/// 큰 파일도 메모리 bounded + chunk 경계마다 취소 가능 + 바이트 진행률 emit.
async fn copy_execute_relay(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    // 누적 바이트 진행률 — plan 전체 크기 대비. chunk 마다 호출되되 ~150ms throttle.
    let total = plan.total_size_bytes;
    let done = std::sync::atomic::AtomicU64::new(0);
    let last = std::sync::Mutex::new(std::time::Instant::now());
    let on_bytes = move |delta: u64| {
        use std::sync::atomic::Ordering::Relaxed;
        let d = done.fetch_add(delta, Relaxed) + delta;
        let Some(p) = progress.as_ref() else { return };
        let complete = d >= total;
        if let Ok(mut l) = last.lock() {
            let now = std::time::Instant::now();
            if !complete && now.duration_since(*l) < std::time::Duration::from_millis(150) {
                return;
            }
            *l = now;
        }
        let shown = d.min(total);
        let percent = if total > 0 {
            (shown * 100 / total) as u8
        } else {
            0
        };
        p.emit(crate::services::task_events::ProgressInfo {
            bytes_done: shown,
            bytes_total: Some(total),
            speed_bps: None,
            eta_sec: None,
            percent: Some(percent),
        });
    };

    let mut copied = Vec::new();
    let mut backups = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());
    for it in &plan.items {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        // 한 항목 처리 — 내부 ?/return 은 이 async 블록만 빠져나와 아래 outcome 으로 잡힘.
        let step: Result<(), DuetError> = async {
            let src_path = it.location.path.join(&it.name);
            let dst_path = plan.dst.path.join(&it.name);

            // 충돌 시 backup 으로 mv (timestamp 충돌은 .<n> suffix 로 retry, 최대 5회)
            if dst_fs.metadata(&dst_path).await.is_ok() {
                let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
                dst_fs.rename(&dst_path, &backup).await?;
                backups.push(BackupRestore {
                    backup_path: backup,
                    original_path: dst_path.clone(),
                });
            }

            // copy 본체 — chunk 스트리밍(메모리 bounded, mid-file cancel). connection loss 면
            // 1회 retry 하되 resume=true 로 중단된 .part 부터 이어받음(전송 재개).
            match crate::fs::copy_relay_streaming(
                src_fs,
                &src_path,
                dst_fs,
                &dst_path,
                false,
                &cancel_token,
                &on_bytes,
            )
            .await
            {
                Ok(()) => {}
                Err(e) if crate::services::retry::is_retryable_error(&e) => {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if cancel_token.is_cancelled() {
                        return Err(DuetError::Cancelled);
                    }
                    crate::fs::copy_relay_streaming(
                        src_fs,
                        &src_path,
                        dst_fs,
                        &dst_path,
                        true, // 재개 — 이미 쓴 .part 이어받기
                        &cancel_token,
                        &on_bytes,
                    )
                    .await?;
                }
                Err(e) => return Err(e),
            }
            copied.push(dst_path);
            Ok(())
        }
        .await;
        if let Err(e) = step {
            outcome = Err(e);
            break;
        }
    }

    // §4: 부분 진행분(복사 완료 + 충돌 백업)이라도 journal 에 기록한 뒤 에러 전파.
    if copied.is_empty() && backups.is_empty() {
        outcome?;
        return Err(DuetError::Io("copy affected nothing".into()));
    }
    let count = copied.len() as u32;
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    let entry = ctx.journal.push(op, undo).await?;
    outcome?;
    Ok(entry)
}

// === Move ===

pub async fn move_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
) -> Result<MovePlan, DuetError> {
    let copy = copy_plan(src_fs, dst_fs, items, dst.clone()).await?;
    let is_same_fs = copy.src_source == dst.source;
    Ok(MovePlan {
        src_source: copy.src_source,
        dst: copy.dst,
        items: copy.items,
        conflicts: copy.conflicts,
        is_same_fs,
        total_size_bytes: copy.total_size_bytes,
        strategy: copy.strategy,
    })
}

pub async fn move_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: MovePlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    _progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    // MVP-3 v1: same-host SSH move 는 미지원 (다른 user 에서 rename 안 되는 케이스 등).
    // 후속에서 same_host_copy + trash 헬퍼 분리 후 지원.
    if plan.strategy == CopyStrategy::SshSameHost {
        return Err(DuetError::NotSupported(
            "same-host SSH move: MVP-3 v2 후속".into(),
        ));
    }

    let mut moved = Vec::new();
    let mut backups = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());
    for it in &plan.items {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        // 한 항목 처리 — 내부 ?/return 은 이 async 블록만 빠져나와 아래 outcome 으로 잡힘.
        let step: Result<(), DuetError> = async {
            let src_path = it.location.path.join(&it.name);
            let dst_path = plan.dst.path.join(&it.name);

            if dst_fs.metadata(&dst_path).await.is_ok() {
                let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
                dst_fs.rename(&dst_path, &backup).await?;
                backups.push(BackupRestore {
                    backup_path: backup,
                    original_path: dst_path.clone(),
                });
            }

            if plan.is_same_fs {
                // 같은 fs: 단순 rename — 빠르고 atomic
                src_fs.rename(&src_path, &dst_path).await?;
            } else {
                // copy 본체 — connection loss 면 1회 retry
                match crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await {
                    Ok(()) => {}
                    Err(e) if crate::services::retry::is_retryable_error(&e) => {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        if cancel_token.is_cancelled() {
                            return Err(DuetError::Cancelled);
                        }
                        crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
                    }
                    Err(e) => return Err(e),
                }
                // src 는 휴지통으로 (영구삭제 아님)
                let batch_id = crate::services::trash::new_batch_id();
                src_fs.trash(&src_path, &batch_id).await?;
            }
            moved.push(MoveItem {
                src_original: src_path,
                dst_now: dst_path,
            });
            Ok(())
        }
        .await;
        if let Err(e) = step {
            outcome = Err(e);
            break;
        }
    }

    // §4: 부분 진행분(이동 완료 + 충돌 백업)이라도 journal 에 기록한 뒤 에러 전파.
    if moved.is_empty() && backups.is_empty() {
        outcome?;
        return Err(DuetError::Io("move affected nothing".into()));
    }
    let count = moved.len() as u32;
    let undo = UndoAction::UndoMove {
        src_source: plan.src_source.clone(),
        dst_source: plan.dst.source.clone(),
        moved,
        backups_to_restore: backups,
    };
    let op = OpKind::Move {
        count,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    let entry = ctx.journal.push(op, undo).await?;
    outcome?;
    Ok(entry)
}

// === Sync (단방향 미러) ===

/// 단방향 미러 계획 — src 디렉토리 → dst 디렉토리.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SyncPlan {
    pub src: Location,
    pub dst: Location,
    pub strategy: CopyStrategy,
    /// true 면 src 에 없는 dst 항목을 휴지통으로 보냄(삭제 전파). FE 가 토글.
    pub prune: bool,
}

/// sync 계획 검증 — 양쪽이 디렉토리이고 같은 위치가 아님. 전략 결정.
///
/// v1 은 local↔local 만 지원(완전 undo 가능). same-host SSH(rsync)·cross-host 는
/// 후속 — rsync 변경 추적 없이는 §4 undo 보장이 어렵기 때문(의도적 단계 분리).
pub async fn sync_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    src: Location,
    dst: Location,
) -> Result<SyncPlan, DuetError> {
    if src.source == dst.source && src.path == dst.path {
        return Err(DuetError::Io(
            "sync: source and destination are the same".into(),
        ));
    }
    if src_fs.metadata(&src.path).await?.kind != crate::types::EntryKind::Dir
        || dst_fs.metadata(&dst.path).await?.kind != crate::types::EntryKind::Dir
    {
        return Err(DuetError::Io("sync: both sides must be directories".into()));
    }
    let strategy = decide_strategy(&src.source, &dst.source);
    if !matches!(
        strategy,
        CopyStrategy::LocalToLocal | CopyStrategy::SshSameHost
    ) {
        return Err(DuetError::NotSupported(
            "sync supports local↔local and same-host SSH only (cross-host relay is a follow-up)"
                .into(),
        ));
    }
    Ok(SyncPlan {
        src,
        dst,
        strategy,
        prune: false,
    })
}

/// src 트리의 파일 개수 (진행률 total 용). best-effort — 실패 시 0.
async fn count_files(fs: &dyn FileSystem, dir: &std::path::Path) -> u64 {
    let mut total = 0u64;
    let entries = match fs.list(dir).await {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for e in entries {
        match e.kind {
            crate::types::EntryKind::File => total += 1,
            crate::types::EntryKind::Dir => {
                total += Box::pin(count_files(fs, &dir.join(&e.name))).await;
            }
            _ => {}
        }
    }
    total
}

/// 단방향 미러 실행 — 전략별 분기. local↔local 은 in-Rust 스트리밍 미러,
/// same-host SSH 는 host-side rsync(PC 경유 0). 둘 다 UndoSync 로 복원.
pub async fn sync_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: SyncPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    match plan.strategy {
        CopyStrategy::SshSameHost => {
            sync_execute_same_host(plan, ctx, cancel_token, progress).await
        }
        // LocalToLocal (+ 방어적으로 Relay) — in-Rust 미러.
        _ => sync_execute_local(src_fs, dst_fs, plan, ctx, cancel_token, progress).await,
    }
}

/// 단방향 추가 미러(local) — src 의 새/변경 파일을 dst 로 복사(미변경 skip).
/// 덮어쓰는 dst 파일은 `.bak.<ts>` 백업, 새로 만든 파일은 추적. prune 시 잉여 dst 휴지통.
async fn sync_execute_local(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: SyncPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    let total = count_files(src_fs, &plan.src.path).await;
    let mut state = MirrorState {
        created: Vec::new(),
        backups: Vec::new(),
        done: 0,
        total,
    };
    mirror_dir(
        src_fs,
        dst_fs,
        &plan.src.path,
        &plan.dst.path,
        &cancel_token,
        progress.as_ref(),
        &mut state,
    )
    .await?;
    // prune: src 에 없는 dst 항목을 휴지통으로 (삭제 전파, undo 복원 가능).
    let mut pruned = Vec::new();
    if plan.prune {
        let batch_id = crate::services::trash::new_batch_id();
        prune_pass(
            src_fs,
            &plan.src.path,
            dst_fs,
            &plan.dst.path,
            &cancel_token,
            &batch_id,
            &mut pruned,
        )
        .await?;
    }
    let op = OpKind::Sync {
        count: state.done as u32,
        pruned: pruned.len() as u32,
        src: plan.src.clone(),
        dst: plan.dst.clone(),
    };
    let undo = UndoAction::UndoSync {
        dst_source: plan.dst.source.clone(),
        created: state.created,
        backups_to_restore: state.backups,
        pruned,
    };
    ctx.journal.push(op, undo).await
}

struct MirrorState {
    created: Vec<PathBuf>,
    backups: Vec<BackupRestore>,
    done: u64,
    total: u64,
}

/// src 파일이 dst 와 다른가 (크기 다름 또는 src 가 더 최신).
fn entry_differs(src: &crate::types::Entry, dst: &crate::types::EntryMeta) -> bool {
    src.size != dst.size || src.modified_ms.unwrap_or(0) > dst.modified_ms.unwrap_or(0)
}

async fn mirror_dir(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    src_dir: &std::path::Path,
    dst_dir: &std::path::Path,
    cancel: &tokio_util::sync::CancellationToken,
    progress: Option<&crate::services::task_queue::ProgressEmitter>,
    state: &mut MirrorState,
) -> Result<(), DuetError> {
    let entries = src_fs.list(src_dir).await?;
    for e in entries {
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let s = src_dir.join(&e.name);
        let d = dst_dir.join(&e.name);
        match e.kind {
            crate::types::EntryKind::Dir => {
                if dst_fs.metadata(&d).await.is_err() {
                    dst_fs.mkdir(&d).await?;
                }
                Box::pin(mirror_dir(src_fs, dst_fs, &s, &d, cancel, progress, state)).await?;
            }
            crate::types::EntryKind::File => {
                let dst_meta = dst_fs.metadata(&d).await.ok();
                let needs = match &dst_meta {
                    None => true,
                    Some(dm) => entry_differs(&e, dm),
                };
                if needs {
                    if dst_meta.is_some() {
                        // 덮어쓰기 전 기존 dst 파일 백업 (undo 복원용).
                        let backup = pick_backup_path(dst_fs, dst_dir, &e.name).await?;
                        dst_fs.rename(&d, &backup).await?;
                        state.backups.push(BackupRestore {
                            backup_path: backup,
                            original_path: d.clone(),
                        });
                    } else {
                        state.created.push(d.clone());
                    }
                    crate::fs::copy_relay(src_fs, &s, dst_fs, &d).await?;
                }
                state.done += 1;
                if let Some(p) = progress {
                    if state.total > 0 {
                        let pct = ((state.done.min(state.total)) * 100 / state.total) as u8;
                        p.emit(crate::services::task_events::ProgressInfo {
                            bytes_done: state.done,
                            bytes_total: Some(state.total),
                            speed_bps: None,
                            eta_sec: None,
                            percent: Some(pct),
                        });
                    }
                }
            }
            _ => {} // symlink/other 는 v1 skip.
        }
    }
    Ok(())
}

/// prune: src 에 없는 dst 항목을 휴지통으로 (삭제 전파). dst 에만 있는 디렉토리는
/// 통째 trash(재귀 안 함), 양쪽에 있는 디렉토리는 내부로 재귀. TrashItem 으로 기록(undo).
async fn prune_pass(
    src_fs: &dyn FileSystem,
    src_dir: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst_dir: &std::path::Path,
    cancel: &tokio_util::sync::CancellationToken,
    batch_id: &str,
    pruned: &mut Vec<TrashItem>,
) -> Result<(), DuetError> {
    let dst_entries = dst_fs.list(dst_dir).await.unwrap_or_default();
    for e in dst_entries {
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let dp = dst_dir.join(&e.name);
        let sp = src_dir.join(&e.name);
        // src 존재 판정은 NotFound 만 '삭제됨'으로 본다. 일시적 실패(연결끊김/권한/SFTP
        // 오류)를 `.is_ok()==false` 로 뭉뚱그리면 네트워크 글리치 한 번에 안 지운 dst 를
        // 휴지통으로 보낸다(compare 의 Unreadable 가드와 같은 사고 클래스). → 에러는 전파.
        match src_fs.metadata(&sp).await {
            Ok(_) => {
                // 양쪽 존재 — 디렉토리면 내부 prune 재귀(파일은 mirror 가 이미 동기화).
                if e.kind == crate::types::EntryKind::Dir {
                    Box::pin(prune_pass(
                        src_fs, &sp, dst_fs, &dp, cancel, batch_id, pruned,
                    ))
                    .await?;
                }
            }
            Err(DuetError::NotFound(_)) => {
                // 명확히 src 에 없음 — 휴지통으로 (디렉토리면 통째).
                let loc = dst_fs.trash(&dp, batch_id).await?;
                let trash_path = match &loc {
                    TrashLocation::Local { trash_id } => trash_id.clone(),
                    TrashLocation::Remote { trash_path } => {
                        trash_path.to_string_lossy().into_owned()
                    }
                };
                pruned.push(TrashItem {
                    trash_path,
                    original_path: dp,
                });
            }
            // 일시적 실패 — '삭제됨' 으로 오인 금지. prune 중단하고 전파.
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// same-host SSH 단방향 미러 — host-side rsync (PC 경유 0, §9 시스템 ssh 안 씀).
///
/// undo(§4): ① dry-run `rsync -ain` 으로 *새로 생성될 파일* 목록 확보(itemize),
/// ② 실제는 `--backup-dir` 로 실행해 덮어쓰기/삭제분을 host-side 백업폴더에 보존,
/// ③ undo 는 UndoSync 가 생성분 rm + 백업분 복원. rsync 필수(cp 로는 mirror 불가).
async fn sync_execute_same_host(
    plan: SyncPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    use crate::core::copy_progress::{
        parse_rsync_itemize_created_file, parse_rsync_progress2_line,
    };
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::{exec, exec_streaming};

    let SourceId::Ssh { connection_id, .. } = &plan.src.source else {
        return Err(DuetError::Io("same-host sync on non-ssh source".into()));
    };
    let pool = ctx
        .pool
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.pool required for same-host sync".into()))?;
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;

    // rsync 필수 — mirror(+삭제)는 cp 로 불가.
    let use_rsync = {
        let mut cache = conn.rsync_available.lock().await;
        match *cache {
            Some(v) => v,
            None => {
                let handle = session_mutex.lock().await;
                let d = exec(&handle, "command -v rsync")
                    .await
                    .map(|o| o.exit_status == 0)
                    .unwrap_or(false);
                *cache = Some(d);
                d
            }
        }
    };
    if !use_rsync {
        return Err(DuetError::NotSupported(
            "same-host sync requires rsync on the host".into(),
        ));
    }

    // host home 아래 백업폴더(undo 복원용). 절대경로로 shell-escape (§7).
    let home = crate::fs::SshFs::new(pool.get(connection_id).await?)
        .home()
        .await?;
    let batch = crate::services::trash::new_batch_id();
    let backup_dir = home.join(".duet-trash").join(format!("sync-{batch}"));

    let src_arg = shell_escape_path(&plan.src.path)?;
    let dst_arg = shell_escape_path(&plan.dst.path)?;
    let backup_arg = shell_escape_path(&backup_dir)?;
    let delete_flag = if plan.prune { " --delete" } else { "" };

    // 1) dry-run itemize → 새로 생성될 파일(undo rm 대상). LC_ALL=C 로 메시지 로캘 고정.
    //    src 에 trailing slash → 내용 미러(merge), dst 에 떨어뜨림.
    let dry_cmd = format!("LC_ALL=C rsync -ain{delete_flag} -- {src_arg}/ {dst_arg}");
    let dry_out = {
        let handle = session_mutex.lock().await;
        exec(&handle, &dry_cmd).await?
    };
    if dry_out.exit_status != 0 {
        return Err(DuetError::Ssh(format!(
            "rsync dry-run failed (exit {}): {}",
            dry_out.exit_status,
            String::from_utf8_lossy(&dry_out.stderr).trim()
        )));
    }
    let mut created = Vec::new();
    for line in String::from_utf8_lossy(&dry_out.stdout).lines() {
        if let Some(rel) = parse_rsync_itemize_created_file(line) {
            created.push(plan.dst.path.join(&rel));
        }
    }

    if cancel_token.is_cancelled() {
        return Err(DuetError::Cancelled);
    }

    // 2) 실제 실행 — --backup-dir 로 덮어쓰기/삭제분 보존, progress2.
    let real_cmd = format!(
        "mkdir -p {backup_arg} && LC_ALL=C rsync -a --info=progress2{delete_flag} \
         --backup --backup-dir={backup_arg} -- {src_arg}/ {dst_arg}"
    );
    let mut last_emit = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(2))
        .unwrap_or_else(std::time::Instant::now);
    let progress_cb = progress.clone();
    let exec_result = {
        let handle = session_mutex.lock().await;
        exec_streaming(&handle, &real_cmd, |line| {
            if let Some(p) = parse_rsync_progress2_line(line) {
                let now = std::time::Instant::now();
                if p.percent == 100
                    || now.duration_since(last_emit) >= std::time::Duration::from_secs(1)
                {
                    last_emit = now;
                    if let Some(em) = &progress_cb {
                        em.emit(crate::services::task_events::ProgressInfo {
                            bytes_done: p.bytes_done,
                            bytes_total: None,
                            speed_bps: Some(p.speed_bps),
                            eta_sec: Some(p.eta_sec),
                            percent: Some(p.percent),
                        });
                    }
                }
            }
        })
        .await
    };
    let (exit, stderr) = match exec_result {
        Ok(r) => r,
        Err(e) if crate::services::retry::is_retryable_error(&e) => {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if cancel_token.is_cancelled() {
                return Err(DuetError::Cancelled);
            }
            let handle = session_mutex.lock().await;
            exec_streaming(&handle, &real_cmd, |_| {}).await?
        }
        Err(e) => return Err(e),
    };
    if exit != 0 {
        return Err(DuetError::Ssh(format!(
            "rsync sync failed (exit {}): {}",
            exit,
            String::from_utf8_lossy(&stderr).trim()
        )));
    }

    // 3) backup_dir 재귀 나열 → 복원 대상(덮어쓰기+삭제분). 각각 backup_dir/rel → dst/rel.
    let dst_fs = crate::fs::SshFs::new(pool.get(connection_id).await?);
    let mut backups = Vec::new();
    collect_backup_files(
        &dst_fs,
        &backup_dir,
        &backup_dir,
        &plan.dst.path,
        &mut backups,
    )
    .await;

    let op = OpKind::Sync {
        count: created.len() as u32,
        pruned: if plan.prune { backups.len() as u32 } else { 0 },
        src: plan.src.clone(),
        dst: plan.dst.clone(),
    };
    let undo = UndoAction::UndoSync {
        dst_source: plan.dst.source.clone(),
        created,
        backups_to_restore: backups,
        pruned: vec![],
    };
    ctx.journal.push(op, undo).await
}

/// backup_dir 트리의 모든 파일을 `BackupRestore{backup_dir/rel → dst/rel}` 로 수집.
async fn collect_backup_files(
    fs: &dyn FileSystem,
    dir: &std::path::Path,
    backup_root: &std::path::Path,
    dst_root: &std::path::Path,
    out: &mut Vec<BackupRestore>,
) {
    let entries = fs.list(dir).await.unwrap_or_default();
    for e in entries {
        let p = dir.join(&e.name);
        if e.kind == crate::types::EntryKind::Dir {
            Box::pin(collect_backup_files(fs, &p, backup_root, dst_root, out)).await;
        } else if let Ok(rel) = p.strip_prefix(backup_root) {
            out.push(BackupRestore {
                backup_path: p.clone(),
                original_path: dst_root.join(rel),
            });
        }
    }
}

// === Sync preview (dry-run — 복사/prune 목록) ===

/// 단방향 미러 dry-run 결과 — 실제 sync 와 같은 판정으로 산출.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SyncPreview {
    /// src→dst 복사될 항목(상대경로).
    pub copy: Vec<String>,
    /// prune(삭제 전파) 시 dst 에서 휴지통으로 갈 항목(상대경로).
    pub prune: Vec<String>,
    /// 상한 초과로 일부만 담겼는지.
    pub truncated: bool,
}

const SYNC_PREVIEW_CAP: usize = 2000;

fn rel_join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}") // 표시용 상대경로(실경로는 PathBuf::join, §7)
    }
}

/// 단방향 미러 dry-run — 복사/prune 목록. local/relay 는 in-Rust 워크(entry_differs
/// 로 실제 sync 와 동일 판정), same-host 는 `rsync -ain --delete` itemize.
pub async fn sync_preview(
    src_fs: &dyn FileSystem,
    src: &Location,
    dst_fs: &dyn FileSystem,
    dst: &Location,
    pool: Option<&Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<SyncPreview, DuetError> {
    match crate::core::copy_strategy::decide(&src.source, &dst.source) {
        crate::core::copy_strategy::CopyStrategy::SshSameHost => {
            let pool = pool
                .ok_or_else(|| DuetError::Io("pool required for same-host sync preview".into()))?;
            sync_preview_same_host(src, dst, pool).await
        }
        _ => {
            let mut p = SyncPreview {
                copy: Vec::new(),
                prune: Vec::new(),
                truncated: false,
            };
            preview_copy_walk(src_fs, &src.path, dst_fs, &dst.path, "", &mut p).await?;
            preview_prune_walk(src_fs, &src.path, dst_fs, &dst.path, "", &mut p).await?;
            Ok(p)
        }
    }
}

/// src 트리를 걸어 복사 대상(dst 없음 또는 entry_differs)을 모은다.
async fn preview_copy_walk(
    src_fs: &dyn FileSystem,
    src_dir: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst_dir: &std::path::Path,
    rel: &str,
    out: &mut SyncPreview,
) -> Result<(), DuetError> {
    for e in src_fs.list(src_dir).await.unwrap_or_default() {
        if out.copy.len() >= SYNC_PREVIEW_CAP {
            out.truncated = true;
            return Ok(());
        }
        let rel_name = rel_join(rel, &e.name);
        let s = src_dir.join(&e.name);
        let d = dst_dir.join(&e.name);
        match e.kind {
            crate::types::EntryKind::Dir => {
                Box::pin(preview_copy_walk(src_fs, &s, dst_fs, &d, &rel_name, out)).await?;
            }
            crate::types::EntryKind::File => {
                let needs = match dst_fs.metadata(&d).await {
                    Ok(dm) => entry_differs(&e, &dm),
                    Err(_) => true, // dst 없음(또는 접근불가) → 복사 대상
                };
                if needs {
                    out.copy.push(rel_name);
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// dst 트리를 걸어 src 에 없는(NotFound) 항목을 prune 후보로 모은다.
async fn preview_prune_walk(
    src_fs: &dyn FileSystem,
    src_dir: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst_dir: &std::path::Path,
    rel: &str,
    out: &mut SyncPreview,
) -> Result<(), DuetError> {
    for e in dst_fs.list(dst_dir).await.unwrap_or_default() {
        if out.prune.len() >= SYNC_PREVIEW_CAP {
            out.truncated = true;
            return Ok(());
        }
        let rel_name = rel_join(rel, &e.name);
        let sp = src_dir.join(&e.name);
        let dp = dst_dir.join(&e.name);
        match src_fs.metadata(&sp).await {
            Ok(_) => {
                if e.kind == crate::types::EntryKind::Dir {
                    Box::pin(preview_prune_walk(src_fs, &sp, dst_fs, &dp, &rel_name, out)).await?;
                }
            }
            Err(DuetError::NotFound(_)) => out.prune.push(rel_name),
            Err(_) => {} // 일시적 오류 — preview 에서 제외(오인 prune 방지)
        }
    }
    Ok(())
}

/// same-host: `rsync -ain --delete` itemize 로 복사/삭제 목록.
async fn sync_preview_same_host(
    src: &Location,
    dst: &Location,
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
) -> Result<SyncPreview, DuetError> {
    use crate::core::copy_progress::{
        parse_rsync_itemize_delete, parse_rsync_itemize_transfer_file,
    };
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::exec;
    let SourceId::Ssh { connection_id, .. } = &src.source else {
        return Err(DuetError::Io("same-host sync preview on non-ssh".into()));
    };
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    let use_rsync = {
        let mut cache = conn.rsync_available.lock().await;
        match *cache {
            Some(v) => v,
            None => {
                let handle = session_mutex.lock().await;
                let d = exec(&handle, "command -v rsync")
                    .await
                    .map(|o| o.exit_status == 0)
                    .unwrap_or(false);
                *cache = Some(d);
                d
            }
        }
    };
    if !use_rsync {
        return Err(DuetError::NotSupported(
            "same-host sync preview requires rsync".into(),
        ));
    }
    let src_arg = shell_escape_path(&src.path)?;
    let dst_arg = shell_escape_path(&dst.path)?;
    let cmd = format!("LC_ALL=C rsync -ain --delete -- {src_arg}/ {dst_arg}");
    let out = {
        let handle = session_mutex.lock().await;
        exec(&handle, &cmd).await?
    };
    if out.exit_status != 0 {
        return Err(DuetError::Ssh(format!(
            "rsync preview failed (exit {}): {}",
            out.exit_status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let mut p = SyncPreview {
        copy: Vec::new(),
        prune: Vec::new(),
        truncated: false,
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if p.copy.len() + p.prune.len() >= SYNC_PREVIEW_CAP * 2 {
            p.truncated = true;
            break;
        }
        if let Some(rel) = parse_rsync_itemize_transfer_file(line) {
            p.copy.push(rel);
        } else if let Some(rel) = parse_rsync_itemize_delete(line) {
            p.prune.push(rel);
        }
    }
    Ok(p)
}

// === Bidirectional merge (안전 — 한쪽에만 있는 파일을 반대편으로 복사, 충돌 미변경) ===

/// 두 디렉토리를 양방향 머지 — `compare_dirs` 결과에서 LeftOnly 는 오른쪽으로,
/// RightOnly 는 왼쪽으로 복사한다. **차이(differ/newer)·동일(same)은 절대 건드리지
/// 않음** (덮어쓰기로 한쪽 편집을 잃지 않도록). 추가 전용이라 UndoBidirMerge 로
/// 완전 복원(양쪽에 새로 만든 파일 제거). 진행률은 항목 개수 기준.
#[allow(clippy::too_many_arguments)]
pub async fn merge_bidir(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    detect_renames_opt: bool,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    use crate::core::compare::CompareStatus;
    let mut plan =
        crate::core::compare::compare_dirs(left_fs, left.clone(), right_fs, right.clone()).await?;
    // 이동/이름변경 감지 시 — 이동 쌍을 entries 에서 제외해 양쪽 중복복제를 차단(핵심 안전).
    if detect_renames_opt {
        detect_renames(&mut plan, left_fs, right_fs, ctx.pool.as_ref()).await?;
    }
    // 비교가 상한에서 잘렸으면 머지 거부 — 5000번째 이후를 조용히 누락하면 §4 위반.
    // (사용자가 범위를 좁히거나 후속 스트리밍 비교를 써야 함.)
    if plan.truncated {
        return Err(DuetError::Io(
            "merge refused: comparison was truncated (too many entries) — narrow the scope".into(),
        ));
    }
    // LeftOnly/RightOnly 만 복사(추가 전용). Unreadable·차이·동일은 자연 제외.
    // (status, rel) 만 owned 로 추출 — plan 의 borrow 를 끊어 전략별 함수에 넘긴다.
    let work: Vec<(CompareStatus, String)> = plan
        .entries
        .iter()
        .filter(|e| matches!(e.status, CompareStatus::LeftOnly | CompareStatus::RightOnly))
        .map(|e| (e.status, e.rel.clone()))
        .collect();

    // 전략 분기: same-host 면 host-side 직접 복사(본인 PC 경유 0, §9). 그 외(로컬·relay)는
    // in-Rust copy_relay. 둘 다 추가 전용이라 UndoBidirMerge(생성분 제거)로 완전 복원.
    match crate::core::copy_strategy::decide(&left.source, &right.source) {
        crate::core::copy_strategy::CopyStrategy::SshSameHost => {
            merge_same_host(left, right, work, ctx, cancel_token, progress).await
        }
        _ => {
            merge_relay(
                left_fs,
                left,
                right_fs,
                right,
                work,
                ctx,
                cancel_token,
                progress,
            )
            .await
        }
    }
}

/// merge 진행률 emit (항목 개수 기준).
fn emit_merge_progress(
    progress: &Option<crate::services::task_queue::ProgressEmitter>,
    done: u64,
    total: u64,
) {
    if let Some(p) = progress {
        let percent = if total > 0 {
            (done * 100 / total) as u8
        } else {
            100
        };
        p.emit(crate::services::task_events::ProgressInfo {
            bytes_done: done,
            bytes_total: Some(total),
            speed_bps: None,
            eta_sec: None,
            percent: Some(percent),
        });
    }
}

/// merge 결과를 journal 에 기록 (relay/same-host 공통).
async fn push_merge_journal(
    ctx: &OpCtx,
    left: Location,
    right: Location,
    left_created: Vec<PathBuf>,
    right_created: Vec<PathBuf>,
) -> Result<JournalEntry, DuetError> {
    let op = OpKind::Merge {
        left: left.clone(),
        right: right.clone(),
        to_left: left_created.len() as u32,
        to_right: right_created.len() as u32,
    };
    let undo = UndoAction::UndoBidirMerge {
        left_source: left.source,
        left_created,
        right_source: right.source,
        right_created,
    };
    ctx.journal.push(op, undo).await
}

/// in-Rust 머지 (로컬·cross-host relay) — 본인 PC 를 거쳐 스트림 복사.
#[allow(clippy::too_many_arguments)]
async fn merge_relay(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    work: Vec<(crate::core::compare::CompareStatus, String)>,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    use crate::core::compare::CompareStatus;
    let total = work.len() as u64;
    let mut done = 0u64;
    let mut left_created = Vec::new();
    let mut right_created = Vec::new();
    // 조기 반환 금지 — 실패/취소여도 그때까지 생성분을 journal 에 남겨 undo 가능(§4).
    let mut outcome: Result<(), DuetError> = Ok(());
    for (status, rel) in &work {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let rel = std::path::Path::new(rel);
        let res = match status {
            CompareStatus::LeftOnly => {
                let s = left.path.join(rel);
                let d = right.path.join(rel);
                // 추가 전용 불변식 강제: race 로 dst 가 생겼으면 덮어쓰지 않고 skip.
                if right_fs.metadata(&d).await.is_ok() {
                    tracing::warn!("merge skip (dst exists): {}", d.display());
                    Ok(())
                } else {
                    // 실패해도 부분 산출물 정리를 위해 dst 를 created 에 기록.
                    let r = crate::fs::copy_relay(left_fs, &s, right_fs, &d).await;
                    right_created.push(d);
                    r
                }
            }
            CompareStatus::RightOnly => {
                let s = right.path.join(rel);
                let d = left.path.join(rel);
                if left_fs.metadata(&d).await.is_ok() {
                    tracing::warn!("merge skip (dst exists): {}", d.display());
                    Ok(())
                } else {
                    let r = crate::fs::copy_relay(right_fs, &s, left_fs, &d).await;
                    left_created.push(d);
                    r
                }
            }
            _ => Ok(()),
        };
        if let Err(e) = res {
            outcome = Err(e);
            break;
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    let entry = push_merge_journal(ctx, left, right, left_created, right_created).await?;
    outcome?;
    Ok(entry)
}

/// same-host SSH 머지 — host-side cp/rsync (본인 PC 경유 0, §9 시스템 ssh 안 씀).
///
/// LeftOnly 는 left connection 으로 left→right, RightOnly 는 right connection 으로
/// right→left 를 서버 내에서 직접 복사. 추가 전용(덮어쓰기 없음)이라 생성분 경로만
/// 추적하면 UndoBidirMerge 로 완전 복원 — sync 의 itemize undo 난제를 우회한다.
async fn merge_same_host(
    left: Location,
    right: Location,
    work: Vec<(crate::core::compare::CompareStatus, String)>,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    use crate::core::compare::CompareStatus;
    let pool = ctx
        .pool
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.pool required for same-host merge".into()))?;
    let SourceId::Ssh {
        connection_id: left_conn,
        ..
    } = &left.source
    else {
        return Err(DuetError::Io("same-host merge on non-ssh left".into()));
    };
    let SourceId::Ssh {
        connection_id: right_conn,
        ..
    } = &right.source
    else {
        return Err(DuetError::Io("same-host merge on non-ssh right".into()));
    };

    let total = work.len() as u64;
    let mut done = 0u64;
    let mut left_created = Vec::new();
    let mut right_created = Vec::new();
    // 조기 반환 금지 — 실패/취소여도 부분 생성분(통째 복사 디렉토리 포함)을 journal 에
    // 남겨 Ctrl+Z 로 정리 가능(§4). 실패 항목의 dst 도 partial 트리 청소 위해 기록.
    let mut outcome: Result<(), DuetError> = Ok(());
    for (status, rel) in &work {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let rel = std::path::Path::new(rel);
        let res = match status {
            CompareStatus::LeftOnly => {
                let s = left.path.join(rel);
                let d = right.path.join(rel);
                match host_side_copy_one(pool, left_conn, &s, &d).await {
                    Ok(true) => {
                        right_created.push(d);
                        Ok(())
                    }
                    Ok(false) => {
                        tracing::warn!("merge skip (dst exists): {}", d.display());
                        Ok(())
                    }
                    Err(e) => {
                        right_created.push(d); // partial 트리 정리용
                        Err(e)
                    }
                }
            }
            CompareStatus::RightOnly => {
                let s = right.path.join(rel);
                let d = left.path.join(rel);
                match host_side_copy_one(pool, right_conn, &s, &d).await {
                    Ok(true) => {
                        left_created.push(d);
                        Ok(())
                    }
                    Ok(false) => {
                        tracing::warn!("merge skip (dst exists): {}", d.display());
                        Ok(())
                    }
                    Err(e) => {
                        left_created.push(d);
                        Err(e)
                    }
                }
            }
            _ => Ok(()),
        };
        if let Err(e) = res {
            outcome = Err(e);
            break;
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    let entry = push_merge_journal(ctx, left, right, left_created, right_created).await?;
    outcome?;
    Ok(entry)
}

/// 한 항목을 host-side cp/rsync 로 직접 복사 (지정 connection 의 세션에서 exec).
/// dst 부모 디렉토리는 항상 존재(compare 가 양쪽-존재 디렉토리만 재귀하므로).
///
/// 반환 `true`=복사함, `false`=dst 가 이미 존재해 건너뜀(추가 전용 불변식 — race 로
/// dst 생성 시 cp 중첩/rsync 덮어쓰기를 방지). same-host 라 conn 으로 dst stat 가능.
async fn host_side_copy_one(
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
    conn_id: &crate::types::ConnectionId,
    src: &std::path::Path,
    dst: &std::path::Path,
) -> Result<bool, DuetError> {
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::exec;

    let conn = pool.get(conn_id).await?;

    // 추가 전용 가드: dst 가 이미 존재하면 복사하지 않고 skip(덮어쓰기/중첩 방지).
    let dst_fs = crate::fs::SshFs::new(pool.get(conn_id).await?);
    if dst_fs.metadata(dst).await.is_ok() {
        return Ok(false);
    }

    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;

    // rsync 탐지(캐시) — 락 순서: rsync_available → session (데드락 회피).
    let use_rsync = {
        let mut cache = conn.rsync_available.lock().await;
        match *cache {
            Some(v) => v,
            None => {
                let handle = session_mutex.lock().await;
                let d = exec(&handle, "command -v rsync")
                    .await
                    .map(|o| o.exit_status == 0)
                    .unwrap_or(false);
                *cache = Some(d);
                d
            }
        }
    };

    let src_arg = shell_escape_path(src)?;
    let cmd = if use_rsync {
        // rsync 는 SRC(trailing-slash 없음)의 basename 을 DEST 디렉토리 안에 만든다 →
        // dst 의 부모를 줘야 dst/<basename> 으로 떨어진다 (file/dir 동일).
        let dst_parent = dst
            .parent()
            .ok_or_else(|| DuetError::Io("dst has no parent".into()))?;
        let dst_parent_arg = shell_escape_path(dst_parent)?;
        format!("rsync -a -- {src_arg} {dst_parent_arg}")
    } else {
        // cp 는 DEST 를 새 이름으로 → 최종 경로 그대로.
        let dst_arg = shell_escape_path(dst)?;
        format!("cp -a -- {src_arg} {dst_arg}")
    };

    let out = {
        let handle = session_mutex.lock().await;
        exec(&handle, &cmd).await?
    };
    if out.exit_status != 0 {
        return Err(DuetError::Ssh(format!(
            "{} failed (exit {}): {} (dst 에 부분 결과가 남았을 수 있음 — undo 로 정리 가능)",
            if use_rsync { "rsync" } else { "cp" },
            out.exit_status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(true)
}

// === Compare apply (행별 방향 적용 — 생성 + 덮어쓰기(백업)) ===

/// 비교 한 행의 적용 방향.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ApplyDirection {
    /// 왼쪽 → 오른쪽.
    ToRight,
    /// 오른쪽 → 왼쪽.
    ToLeft,
    /// 적용 안 함.
    Skip,
}

/// 비교 적용 결정(행별).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ApplyDecision {
    pub rel: String,
    pub direction: ApplyDirection,
}

/// 적용 진행 중 생성/백업 추적 — undo(UndoCompareApply) 입력.
#[derive(Default)]
struct ApplyState {
    left_created: Vec<PathBuf>,
    right_created: Vec<PathBuf>,
    left_backups: Vec<BackupRestore>,
    right_backups: Vec<BackupRestore>,
}

/// 비교창에서 고른 행별 방향을 적용 — 생성은 추적, 덮어쓰기는 `.bak` 백업 후 복사.
/// 전부 단일 JournalEntry(UndoCompareApply)로 묶여 Ctrl+Z 한 번에 복원(§4).
/// same-host 는 host-side(PC 경유 0), 그 외는 in-Rust relay. Skip 은 제외.
#[allow(clippy::too_many_arguments)]
pub async fn apply_compare(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    decisions: Vec<ApplyDecision>,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    let work: Vec<(ApplyDirection, String)> = decisions
        .into_iter()
        .filter(|d| !matches!(d.direction, ApplyDirection::Skip))
        .map(|d| (d.direction, d.rel))
        .collect();
    match crate::core::copy_strategy::decide(&left.source, &right.source) {
        crate::core::copy_strategy::CopyStrategy::SshSameHost => {
            apply_same_host(left, right, work, ctx, cancel_token, progress).await
        }
        _ => {
            apply_relay(
                left_fs,
                left,
                right_fs,
                right,
                work,
                ctx,
                cancel_token,
                progress,
            )
            .await
        }
    }
}

/// 적용 결과를 journal 에 기록 (relay/same-host 공통).
async fn push_compare_apply_journal(
    ctx: &OpCtx,
    left: Location,
    right: Location,
    st: ApplyState,
) -> Result<JournalEntry, DuetError> {
    let overwritten = (st.left_backups.len() + st.right_backups.len()) as u32;
    let applied = (st.left_created.len() + st.right_created.len()) as u32 + overwritten;
    let op = OpKind::CompareApply {
        left: left.clone(),
        right: right.clone(),
        applied,
        overwritten,
    };
    let undo = UndoAction::UndoCompareApply {
        left_source: left.source,
        right_source: right.source,
        left_created: st.left_created,
        right_created: st.right_created,
        left_backups: st.left_backups,
        right_backups: st.right_backups,
    };
    ctx.journal.push(op, undo).await
}

/// 한 행을 relay 로 적용 — dst 존재면 백업 후 복사, 아니면 생성 기록 후 복사.
#[allow(clippy::too_many_arguments)]
async fn apply_one_relay(
    direction: &ApplyDirection,
    rel: &std::path::Path,
    left_fs: &dyn FileSystem,
    left: &Location,
    right_fs: &dyn FileSystem,
    right: &Location,
    st: &mut ApplyState,
) -> Result<(), DuetError> {
    let (src_fs, src_path, dst_fs, dst_path, dst_is_left) = match direction {
        ApplyDirection::ToRight => (
            left_fs,
            left.path.join(rel),
            right_fs,
            right.path.join(rel),
            false,
        ),
        ApplyDirection::ToLeft => (
            right_fs,
            right.path.join(rel),
            left_fs,
            left.path.join(rel),
            true,
        ),
        ApplyDirection::Skip => return Ok(()),
    };
    if dst_fs.metadata(&dst_path).await.is_ok() {
        let parent = dst_path
            .parent()
            .ok_or_else(|| DuetError::Io("dst has no parent".into()))?;
        let name = dst_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| DuetError::Io("dst has no name".into()))?;
        let backup = pick_backup_path(dst_fs, parent, name).await?;
        dst_fs.rename(&dst_path, &backup).await?;
        let br = BackupRestore {
            backup_path: backup,
            original_path: dst_path.clone(),
        };
        if dst_is_left {
            st.left_backups.push(br);
        } else {
            st.right_backups.push(br);
        }
    } else if dst_is_left {
        st.left_created.push(dst_path.clone());
    } else {
        st.right_created.push(dst_path.clone());
    }
    crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await
}

/// in-Rust relay 적용 (로컬·cross-host). 실패/취소여도 부분 진행분을 journal 에 기록(§4).
#[allow(clippy::too_many_arguments)]
async fn apply_relay(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    work: Vec<(ApplyDirection, String)>,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    let total = work.len() as u64;
    let mut done = 0u64;
    let mut st = ApplyState::default();
    let mut outcome: Result<(), DuetError> = Ok(());
    for (direction, rel) in &work {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let rel_path = std::path::Path::new(rel);
        if let Err(e) = apply_one_relay(
            direction, rel_path, left_fs, &left, right_fs, &right, &mut st,
        )
        .await
        {
            outcome = Err(e);
            break;
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    let entry = push_compare_apply_journal(ctx, left, right, st).await?;
    outcome?;
    Ok(entry)
}

/// same-host SSH 적용 — dst 백업(SFTP rename)으로 부재화 후 host-side cp/rsync 복사.
async fn apply_same_host(
    left: Location,
    right: Location,
    work: Vec<(ApplyDirection, String)>,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    let pool = ctx
        .pool
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.pool required for same-host apply".into()))?;
    let SourceId::Ssh {
        connection_id: left_conn,
        ..
    } = &left.source
    else {
        return Err(DuetError::Io("same-host apply on non-ssh left".into()));
    };
    let SourceId::Ssh {
        connection_id: right_conn,
        ..
    } = &right.source
    else {
        return Err(DuetError::Io("same-host apply on non-ssh right".into()));
    };

    let total = work.len() as u64;
    let mut done = 0u64;
    let mut st = ApplyState::default();
    let mut outcome: Result<(), DuetError> = Ok(());
    for (direction, rel) in &work {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let rel_path = std::path::Path::new(rel);
        if let Err(e) = apply_one_same_host(
            direction, rel_path, &left, left_conn, &right, right_conn, pool, &mut st,
        )
        .await
        {
            outcome = Err(e);
            break;
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    let entry = push_compare_apply_journal(ctx, left, right, st).await?;
    outcome?;
    Ok(entry)
}

/// 한 행을 host-side 로 적용 — dst 존재면 SFTP 백업으로 부재화 후 cp/rsync exec.
#[allow(clippy::too_many_arguments)]
async fn apply_one_same_host(
    direction: &ApplyDirection,
    rel: &std::path::Path,
    left: &Location,
    left_conn: &crate::types::ConnectionId,
    right: &Location,
    right_conn: &crate::types::ConnectionId,
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
    st: &mut ApplyState,
) -> Result<(), DuetError> {
    let (src_path, src_conn, dst_path, dst_conn, dst_is_left) = match direction {
        ApplyDirection::ToRight => (
            left.path.join(rel),
            left_conn,
            right.path.join(rel),
            right_conn,
            false,
        ),
        ApplyDirection::ToLeft => (
            right.path.join(rel),
            right_conn,
            left.path.join(rel),
            left_conn,
            true,
        ),
        ApplyDirection::Skip => return Ok(()),
    };
    // dst 존재면 SFTP rename 으로 백업 → dst 부재화(이후 host_side_copy_one 이 복사).
    let dst_fs = crate::fs::SshFs::new(pool.get(dst_conn).await?);
    if dst_fs.metadata(&dst_path).await.is_ok() {
        let parent = dst_path
            .parent()
            .ok_or_else(|| DuetError::Io("dst has no parent".into()))?;
        let name = dst_path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| DuetError::Io("dst has no name".into()))?;
        let backup = pick_backup_path(&dst_fs, parent, name).await?;
        dst_fs.rename(&dst_path, &backup).await?;
        let br = BackupRestore {
            backup_path: backup,
            original_path: dst_path.clone(),
        };
        if dst_is_left {
            st.left_backups.push(br);
        } else {
            st.right_backups.push(br);
        }
    } else if dst_is_left {
        st.left_created.push(dst_path.clone());
    } else {
        st.right_created.push(dst_path.clone());
    }
    // dst 부재 보장됨 → host_side_copy_one 은 실제 복사(Ok(true)) 후 반환.
    host_side_copy_one(pool, src_conn, &src_path, &dst_path).await?;
    Ok(())
}

// === 3-way 자동 적용 (base 대비 변경/추가/삭제를 반대편에 반영) ===

/// 한 rel 을 root 에서 휴지통으로 보내고 추적(undo 복원용).
async fn trash_rel(
    fs: &dyn FileSystem,
    root: &Location,
    rel: &std::path::Path,
    batch: &str,
    out: &mut Vec<TrashItem>,
) -> Result<(), DuetError> {
    let p = root.path.join(rel);
    let loc = fs.trash(&p, batch).await?;
    let trash_path = match &loc {
        TrashLocation::Local { trash_id } => trash_id.clone(),
        TrashLocation::Remote { trash_path } => trash_path.to_string_lossy().into_owned(),
    };
    out.push(TrashItem {
        trash_path,
        original_path: p,
    });
    Ok(())
}

/// 3-way 자동 해결 적용 — base 대비 한쪽만 변경/추가면 반대편에 복사(덮어쓰기는 .bak),
/// 한쪽 삭제면 반대편도 휴지통으로. **충돌은 건너뜀**(사용자 resolve 후속). 전부 단일
/// UndoThreeWayApply(생성 rm + 백업 복원 + 휴지통 복원)로 Ctrl+Z. 실패해도 부분 기록(§4).
#[allow(clippy::too_many_arguments)]
pub async fn apply_three_way(
    base_fs: &dyn FileSystem,
    base: Location,
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    use crate::core::three_way::{compare_three_way, ThreeWayStatus as S};
    let plan = compare_three_way(
        base_fs,
        base.clone(),
        left_fs,
        left.clone(),
        right_fs,
        right.clone(),
    )
    .await?;
    if plan.truncated {
        return Err(DuetError::Io(
            "three-way apply refused: comparison truncated — narrow the scope".into(),
        ));
    }
    let same_host = matches!(
        crate::core::copy_strategy::decide(&left.source, &right.source),
        crate::core::copy_strategy::CopyStrategy::SshSameHost
    );
    let conns = match (&left.source, &right.source) {
        (
            SourceId::Ssh {
                connection_id: lc, ..
            },
            SourceId::Ssh {
                connection_id: rc, ..
            },
        ) if same_host => Some((lc.clone(), rc.clone())),
        _ => None,
    };
    let pool = ctx.pool.clone();

    let mut st = ApplyState::default();
    let mut trashed_left: Vec<TrashItem> = Vec::new();
    let mut trashed_right: Vec<TrashItem> = Vec::new();
    let batch = crate::services::trash::new_batch_id();
    let conflicts = plan.conflicts;
    let total = plan.auto as u64;
    let mut done = 0u64;
    let mut outcome: Result<(), DuetError> = Ok(());

    for entry in &plan.entries {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        if entry.status.is_conflict() {
            continue;
        }
        let rel = std::path::Path::new(&entry.rel);
        let res = match entry.status {
            // base 대비 한쪽만 변경/추가 → 반대편에 복사(덮어쓰기는 apply_one_* 가 .bak).
            S::LeftChanged | S::LeftAdded | S::RightChanged | S::RightAdded => {
                let dir = if matches!(entry.status, S::LeftChanged | S::LeftAdded) {
                    ApplyDirection::ToRight
                } else {
                    ApplyDirection::ToLeft
                };
                if let (Some((lc, rc)), Some(pool)) = (&conns, &pool) {
                    apply_one_same_host(&dir, rel, &left, lc, &right, rc, pool, &mut st).await
                } else {
                    apply_one_relay(&dir, rel, left_fs, &left, right_fs, &right, &mut st).await
                }
            }
            // 한쪽 삭제 → 반대편에서도 휴지통으로(삭제 전파).
            S::LeftDeleted => trash_rel(right_fs, &right, rel, &batch, &mut trashed_right).await,
            S::RightDeleted => trash_rel(left_fs, &left, rel, &batch, &mut trashed_left).await,
            _ => Ok(()),
        };
        if let Err(e) = res {
            outcome = Err(e);
            break;
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }

    let op = OpKind::ThreeWayApply {
        base,
        left: left.clone(),
        right: right.clone(),
        applied: done as u32,
        conflicts,
    };
    let undo = UndoAction::UndoThreeWayApply {
        left_source: left.source,
        right_source: right.source,
        left_created: st.left_created,
        right_created: st.right_created,
        left_backups: st.left_backups,
        right_backups: st.right_backups,
        trashed_left,
        trashed_right,
    };
    let entry = ctx.journal.push(op, undo).await?;
    outcome?;
    Ok(entry)
}

// === Compare verify (내용 검증 — size+mtime 휴리스틱의 '틀린 Same' 잡기) ===

/// 비교 행 내용 검증 결과.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VerifyResult {
    pub rel: String,
    /// `Some(true)`=내용 동일, `Some(false)`=다름, `None`=검증 불가(너무 큼/접근 실패).
    pub equal: Option<bool>,
}

/// relay/local 바이트 비교 상한 — 초과 파일은 None(검증 불가, 네트워크/메모리 보호).
const VERIFY_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 선택된 rel 들의 내용을 검증 — size+mtime 만으로 Same 판정된 항목의 '틀린 Same'
/// (mtime 같지만 내용 다른 빌드산출물·touch·rsync 복원분 등)을 잡는다.
/// same-host 는 host-side sha256(PC 다운로드 0), 그 외는 바이트 비교(64MB 이하).
pub async fn verify_compare(
    left_fs: &dyn FileSystem,
    left: &Location,
    right_fs: &dyn FileSystem,
    right: &Location,
    rels: Vec<String>,
    pool: Option<&Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<Vec<VerifyResult>, DuetError> {
    match crate::core::copy_strategy::decide(&left.source, &right.source) {
        crate::core::copy_strategy::CopyStrategy::SshSameHost => {
            let pool =
                pool.ok_or_else(|| DuetError::Io("pool required for same-host verify".into()))?;
            verify_same_host(left, right, rels, pool).await
        }
        _ => verify_relay(left_fs, left, right_fs, right, rels).await,
    }
}

/// 바이트 비교(로컬·cross-host relay). 크기 다르면 즉시 다름, 64MB 초과는 None.
async fn verify_relay(
    left_fs: &dyn FileSystem,
    left: &Location,
    right_fs: &dyn FileSystem,
    right: &Location,
    rels: Vec<String>,
) -> Result<Vec<VerifyResult>, DuetError> {
    let mut out = Vec::with_capacity(rels.len());
    for rel in rels {
        let rel_path = std::path::Path::new(&rel);
        let lp = left.path.join(rel_path);
        let rp = right.path.join(rel_path);
        let equal = match (left_fs.metadata(&lp).await, right_fs.metadata(&rp).await) {
            (Ok(lm), Ok(rm)) => {
                if lm.size != rm.size {
                    Some(false)
                } else if lm.size.unwrap_or(0) > VERIFY_MAX_BYTES {
                    None
                } else {
                    match (left_fs.read_full(&lp).await, right_fs.read_full(&rp).await) {
                        (Ok(a), Ok(b)) => Some(a == b),
                        _ => None,
                    }
                }
            }
            _ => None,
        };
        out.push(VerifyResult { rel, equal });
    }
    Ok(out)
}

/// host-side sha256(없으면 shasum -a 256)으로 양쪽 해시 비교 — PC 다운로드 0.
async fn verify_same_host(
    left: &Location,
    right: &Location,
    rels: Vec<String>,
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
) -> Result<Vec<VerifyResult>, DuetError> {
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::exec;
    let SourceId::Ssh {
        connection_id: left_conn,
        ..
    } = &left.source
    else {
        return Err(DuetError::Io("same-host verify on non-ssh".into()));
    };
    let conn = pool.get(left_conn).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;

    let mut out = Vec::with_capacity(rels.len());
    for rel in rels {
        let rel_path = std::path::Path::new(&rel);
        let lp = shell_escape_path(&left.path.join(rel_path))?;
        let rp = shell_escape_path(&right.path.join(rel_path))?;
        // 두 파일을 한 exec 로 해시 → 정확히 2개 해시 라인이면 비교, 아니면 None.
        let cmd = format!(
            "if command -v sha256sum >/dev/null 2>&1; then sha256sum -- {lp} {rp}; \
             else shasum -a 256 -- {lp} {rp}; fi"
        );
        let res = {
            let handle = session_mutex.lock().await;
            exec(&handle, &cmd).await
        };
        let equal = match res {
            Ok(o) if o.exit_status == 0 => {
                let s = String::from_utf8_lossy(&o.stdout);
                let mut it = s.lines().filter_map(|l| l.split_whitespace().next());
                match (it.next(), it.next(), it.next()) {
                    (Some(a), Some(b), None) => Some(a == b),
                    _ => None,
                }
            }
            _ => None,
        };
        out.push(VerifyResult { rel, equal });
    }
    Ok(out)
}

// === Trash/백업 용량 가시화 (읽기 전용) ===

/// 원격 `~/.duet-trash` 누적 용량 — 휴지통 prune + same-host sync 백업이 쌓이는 곳.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrashUsage {
    /// 누적 바이트. `available=false` 면 의미 없음(로컬은 OS 휴지통이라 측정 비대상).
    pub bytes: u64,
    pub available: bool,
}

/// 원격 호스트의 `~/.duet-trash` 누적 용량 조회 — host-side `du -sk`(russh exec, §9).
/// 로컬은 OS 휴지통이라 측정 대상이 아님(available=false).
pub async fn trash_usage(
    source: &SourceId,
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
) -> Result<TrashUsage, DuetError> {
    use crate::ssh::remote_exec::exec;
    let SourceId::Ssh { connection_id, .. } = source else {
        return Ok(TrashUsage {
            bytes: 0,
            available: false,
        });
    };
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    // du -sk 는 1024바이트 단위(POSIX -k) — BSD(macOS)/GNU 공통. 없으면 0.
    let out = {
        let handle = session_mutex.lock().await;
        exec(&handle, "du -sk ~/.duet-trash 2>/dev/null | cut -f1").await?
    };
    let kb = String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<u64>()
        .unwrap_or(0);
    Ok(TrashUsage {
        bytes: kb.saturating_mul(1024),
        available: true,
    })
}

// === Rename/move 감지 (이동을 '양쪽 신규'로 오인한 중복복제 차단) ===

/// 후보 파일이 너무 크면 로컬 시그니처(전체 읽기) 생략 — 그 rel 은 고유 sig 로 매칭 제외.
const RENAME_SIG_CAP: u64 = 64 * 1024 * 1024;
/// 후보가 이보다 많으면 감지 생략(비용 보호).
const RENAME_MAX_CANDIDATES: usize = 1000;

/// 이동/이름변경 감지 — LeftOnly+RightOnly 파일 중 *내용 동일* 1:1 쌍을 MoveInfo 로 묶고
/// entries/카운트에서 제외. local + same-host 만(cross-host 후속). 반환: 제외된 rel 집합
/// (merge 가 복사에서 빼는 데 사용). 모호(같은 내용 다수)는 강등(이동 아님).
pub async fn detect_renames(
    plan: &mut crate::core::compare::ComparePlan,
    left_fs: &dyn FileSystem,
    right_fs: &dyn FileSystem,
    pool: Option<&Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<std::collections::HashSet<String>, DuetError> {
    use crate::core::compare::{CompareStatus, MoveInfo};
    use std::collections::{HashMap, HashSet};

    let strategy = crate::core::copy_strategy::decide(&plan.left.source, &plan.right.source);
    let same_host = matches!(
        strategy,
        crate::core::copy_strategy::CopyStrategy::SshSameHost
    );
    let local = matches!(
        strategy,
        crate::core::copy_strategy::CopyStrategy::LocalToLocal
    );
    if !same_host && !local {
        return Ok(HashSet::new()); // cross-host 는 v1 미지원
    }

    let left_c: Vec<(String, u64)> = plan
        .entries
        .iter()
        .filter(|e| e.status == CompareStatus::LeftOnly && e.kind == crate::types::EntryKind::File)
        .map(|e| (e.rel.clone(), e.left_size.unwrap_or(0)))
        .collect();
    let right_c: Vec<(String, u64)> = plan
        .entries
        .iter()
        .filter(|e| e.status == CompareStatus::RightOnly && e.kind == crate::types::EntryKind::File)
        .map(|e| (e.rel.clone(), e.right_size.unwrap_or(0)))
        .collect();
    if left_c.is_empty() || right_c.is_empty() {
        return Ok(HashSet::new());
    }
    // 양쪽 공통 size 만 후보 — 그 외는 매칭 불가.
    let lsizes: HashSet<u64> = left_c.iter().map(|(_, s)| *s).collect();
    let rsizes: HashSet<u64> = right_c.iter().map(|(_, s)| *s).collect();
    let common: HashSet<u64> = lsizes.intersection(&rsizes).copied().collect();
    let left_c: Vec<(String, u64)> = left_c
        .into_iter()
        .filter(|(_, s)| common.contains(s))
        .collect();
    let right_c: Vec<(String, u64)> = right_c
        .into_iter()
        .filter(|(_, s)| common.contains(s))
        .collect();
    if left_c.is_empty()
        || right_c.is_empty()
        || left_c.len() + right_c.len() > RENAME_MAX_CANDIDATES
    {
        return Ok(HashSet::new());
    }

    let left_sig = compute_sigs(left_fs, &plan.left, &left_c, same_host, pool).await?;
    let right_sig = compute_sigs(right_fs, &plan.right, &right_c, same_host, pool).await?;

    let mut lby: HashMap<String, Vec<String>> = HashMap::new();
    for (rel, sig) in left_sig {
        lby.entry(sig).or_default().push(rel);
    }
    let mut rby: HashMap<String, Vec<String>> = HashMap::new();
    for (rel, sig) in right_sig {
        rby.entry(sig).or_default().push(rel);
    }

    let mut moves: Vec<MoveInfo> = Vec::new();
    let mut moved: HashSet<String> = HashSet::new();
    for (sig, lrels) in &lby {
        if let Some(rrels) = rby.get(sig) {
            // 1:1 만 확신 — 다대다/다대일은 모호하므로 이동으로 보지 않음(강등).
            if lrels.len() == 1 && rrels.len() == 1 {
                moves.push(MoveInfo {
                    from_rel: lrels[0].clone(),
                    to_rel: rrels[0].clone(),
                });
                moved.insert(lrels[0].clone());
                moved.insert(rrels[0].clone());
            }
        }
    }

    if !moved.is_empty() {
        plan.entries.retain(|e| {
            !(matches!(e.status, CompareStatus::LeftOnly | CompareStatus::RightOnly)
                && moved.contains(&e.rel))
        });
        plan.left_only = plan.left_only.saturating_sub(moves.len() as u32);
        plan.right_only = plan.right_only.saturating_sub(moves.len() as u32);
    }
    moves.sort_by(|a, b| a.to_rel.cmp(&b.to_rel));
    plan.moves = moves;
    Ok(moved)
}

/// 후보들의 내용 시그니처 — same-host 는 host-side sha256, local 은 바이트 해시.
async fn compute_sigs(
    fs: &dyn FileSystem,
    root: &Location,
    cands: &[(String, u64)],
    same_host: bool,
    pool: Option<&Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<Vec<(String, String)>, DuetError> {
    if same_host {
        let pool =
            pool.ok_or_else(|| DuetError::Io("pool required for same-host rename".into()))?;
        sigs_same_host(root, cands, pool).await
    } else {
        let mut out = Vec::with_capacity(cands.len());
        for (rel, size) in cands {
            let sig = if *size > RENAME_SIG_CAP {
                format!("__big__{rel}") // 고유 — 매칭 안 됨
            } else {
                match fs.read_full(&root.path.join(rel)).await {
                    Ok(bytes) => {
                        use std::hash::{Hash, Hasher};
                        let mut h = std::collections::hash_map::DefaultHasher::new();
                        bytes.hash(&mut h);
                        format!("{:016x}:{}", h.finish(), size)
                    }
                    Err(_) => format!("__err__{rel}"),
                }
            };
            out.push((rel.clone(), sig));
        }
        Ok(out)
    }
}

/// host-side sha256(없으면 shasum -a 256) 으로 후보 일괄 해시 — PC 다운로드 0.
async fn sigs_same_host(
    root: &Location,
    cands: &[(String, u64)],
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
) -> Result<Vec<(String, String)>, DuetError> {
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::exec;
    let SourceId::Ssh { connection_id, .. } = &root.source else {
        return Err(DuetError::Io("same-host rename on non-ssh".into()));
    };
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    // 인자 순서대로 출력 → order-based 매핑(경로 공백 안전). args 순서 == cands 순서.
    let mut args = String::new();
    for (rel, _) in cands {
        args.push(' ');
        args.push_str(&shell_escape_path(&root.path.join(rel))?);
    }
    let cmd = format!(
        "if command -v sha256sum >/dev/null 2>&1; then sha256sum --{args}; else shasum -a 256 --{args}; fi"
    );
    let out = {
        let handle = session_mutex.lock().await;
        exec(&handle, &cmd).await?
    };
    let s = String::from_utf8_lossy(&out.stdout);
    let hashes: Vec<&str> = s
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    if hashes.len() != cands.len() {
        // 정렬 깨짐(누락/에러) — 안전하게 감지 생략.
        return Ok(Vec::new());
    }
    Ok(cands
        .iter()
        .zip(hashes)
        .map(|((rel, _), h)| (rel.clone(), h.to_string()))
        .collect())
}

// === Rename / Mkdir (단순 — plan 불필요) ===

pub async fn rename(
    fs: &dyn FileSystem,
    target: EntryRef,
    new_name: String,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    if new_name.contains('/') || new_name.is_empty() {
        return Err(DuetError::Io(format!("invalid name: {new_name}")));
    }
    let from = target.location.path.join(&target.name);
    let to = target.location.path.join(&new_name);
    if fs.metadata(&to).await.is_ok() {
        return Err(DuetError::Io(format!("target exists: {}", to.display())));
    }
    fs.rename(&from, &to).await?;
    ctx.journal
        .push(
            OpKind::Rename {
                from: from.clone(),
                to: to.clone(),
                source: target.location.source.clone(),
            },
            UndoAction::UndoRename {
                source: target.location.source,
                current: to,
                original: from,
            },
        )
        .await
}

// === Batch rename ===

/// 이름 변환 규칙 — find/replace + case + 순번 + prefix/suffix (정규식 X, §6).
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct RenameRule {
    /// stem 전체를 이 값으로 교체. None/빈 문자열이면 원본 stem 유지.
    pub base: Option<String>,
    /// 리터럴 find (빈 문자열이면 skip). 정규식 아님.
    pub find: String,
    pub replace: String,
    /// true 면 모든 일치, false 면 첫 일치만 치환.
    pub replace_all: bool,
    pub prefix: String,
    pub suffix: String,
    pub seq: Option<SeqRule>,
    pub case: Option<CaseOp>,
    /// true 면 확장자 포함 전체에 적용. false(기본)면 stem 만 변환하고 확장자 보존.
    pub target_ext: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SeqRule {
    pub start: u32,
    pub step: u32,
    /// 0-padding 자릿수 (예: 3 → 001).
    pub padding: u8,
    pub position: SeqPos,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum SeqPos {
    Prefix,
    Suffix,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CaseOp {
    Upper,
    Lower,
    Title,
}

/// preview/실행 공통 — 변환 후 항목.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BatchRenameItem {
    pub old_name: String,
    pub new_name: String,
    /// 빈/슬래시 포함, 배치 내 중복, 선택 외 기존 파일과 충돌 시 true.
    pub collision: bool,
}

/// batch rename 미리보기 결과 — UI 다이얼로그가 표시.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BatchRenamePlan {
    pub source: SourceId,
    pub location: Location,
    pub items: Vec<BatchRenameItem>,
    pub has_collision: bool,
}

/// 파일명의 (stem, ext) 분리. `target_ext` 면 전체를 stem 취급(ext 빈 문자열).
/// 마지막 '.' 기준이되 선행 dot 파일(`.bashrc`)은 확장자 없음으로 본다.
fn split_stem_ext(name: &str, target_ext: bool) -> (&str, &str) {
    if target_ext {
        return (name, "");
    }
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

fn replace_first(haystack: &str, find: &str, replace: &str) -> String {
    match haystack.find(find) {
        Some(i) => format!(
            "{}{}{}",
            &haystack[..i],
            replace,
            &haystack[i + find.len()..]
        ),
        None => haystack.to_string(),
    }
}

fn title_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at_word_start = true;
    for ch in s.chars() {
        if ch.is_alphanumeric() {
            if at_word_start {
                out.extend(ch.to_uppercase());
            } else {
                out.extend(ch.to_lowercase());
            }
            at_word_start = false;
        } else {
            out.push(ch);
            at_word_start = true;
        }
    }
    out
}

/// 규칙을 한 이름에 적용 (순수 함수 — fs 접근 없음). `index` 는 선택 내 위치(0-based).
///
/// 적용 순서: base 교체 → find/replace → case → seq → 리터럴 prefix/suffix → 확장자 복원.
pub fn apply_rename_rule(name: &str, rule: &RenameRule, index: usize) -> String {
    let (stem, ext) = split_stem_ext(name, rule.target_ext);
    let mut work = match &rule.base {
        Some(b) if !b.is_empty() => b.clone(),
        _ => stem.to_string(),
    };
    if !rule.find.is_empty() {
        work = if rule.replace_all {
            work.replace(&rule.find, &rule.replace)
        } else {
            replace_first(&work, &rule.find, &rule.replace)
        };
    }
    if let Some(c) = rule.case {
        work = match c {
            CaseOp::Upper => work.to_uppercase(),
            CaseOp::Lower => work.to_lowercase(),
            CaseOp::Title => title_case(&work),
        };
    }
    if let Some(seq) = &rule.seq {
        let n = seq.start as u64 + index as u64 * seq.step as u64;
        let num = format!("{:0width$}", n, width = seq.padding as usize);
        match seq.position {
            SeqPos::Prefix => work = format!("{num}{work}"),
            SeqPos::Suffix => work = format!("{work}{num}"),
        }
    }
    let mut result = format!("{}{}{}", rule.prefix, work, rule.suffix);
    result.push_str(ext);
    result
}

/// 선택된 이름들에 대한 (old, new, collision) 매핑을 계산.
///
/// collision 판정: 빈/슬래시 포함 → 무효; 배치 내 new 중복; new 가 (자기 자신이
/// 아닌) 선택 항목의 *기존* 이름과 겹침(단일패스 안전 위해 차단); 선택 밖 기존
/// 파일과 충돌. `new == old` 는 no-op 로 충돌 아님.
async fn compute_batch_mapping(
    fs: &dyn FileSystem,
    location: &Location,
    names: &[String],
    rule: &RenameRule,
) -> Vec<(String, String, bool)> {
    let old_set: std::collections::HashSet<&str> = names.iter().map(|s| s.as_str()).collect();
    let new_names: Vec<String> = names
        .iter()
        .enumerate()
        .map(|(i, n)| apply_rename_rule(n, rule, i))
        .collect();
    let mut counts: std::collections::HashMap<&str, u32> = std::collections::HashMap::new();
    for nn in &new_names {
        *counts.entry(nn.as_str()).or_default() += 1;
    }
    let mut out = Vec::with_capacity(names.len());
    for (i, old) in names.iter().enumerate() {
        let new = &new_names[i];
        let dup_in_batch = counts.get(new.as_str()).copied().unwrap_or(0) > 1;
        // 다른 선택 항목의 *기존* 이름과 겹치면 단일패스 안전을 위해 차단.
        let overlaps_selected_old = old_set.contains(new.as_str());
        let collision = if new.is_empty() || new.contains('/') {
            true
        } else if new == old {
            false // no-op
        } else if dup_in_batch || overlaps_selected_old {
            true
        } else {
            fs.metadata(&location.path.join(new)).await.is_ok() // 선택 밖 기존 파일
        };
        out.push((old.clone(), new.clone(), collision));
    }
    out
}

/// 같은 디렉토리의 항목들인지 검증하고 location 을 돌려준다.
fn validate_same_dir(items: &[EntryRef]) -> Result<Location, DuetError> {
    let location = items
        .first()
        .map(|it| it.location.clone())
        .ok_or_else(|| DuetError::Io("batch rename: no targets".into()))?;
    if items
        .iter()
        .any(|it| it.location.source != location.source || it.location.path != location.path)
    {
        return Err(DuetError::Io(
            "batch rename: all items must be in the same directory".into(),
        ));
    }
    Ok(location)
}

/// 비파괴 미리보기 — 변환 결과 + 충돌 플래그. fs 쓰기/journal 없음.
pub async fn batch_rename_preview(
    fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    rule: RenameRule,
) -> Result<BatchRenamePlan, DuetError> {
    let location = validate_same_dir(&items)?;
    let names: Vec<String> = items.iter().map(|it| it.name.clone()).collect();
    let mapping = compute_batch_mapping(fs, &location, &names, &rule).await;
    let has_collision = mapping.iter().any(|(_, _, c)| *c);
    let items = mapping
        .into_iter()
        .map(|(old_name, new_name, collision)| BatchRenameItem {
            old_name,
            new_name,
            collision,
        })
        .collect();
    Ok(BatchRenamePlan {
        source: location.source.clone(),
        location,
        items,
        has_collision,
    })
}

/// 일괄 이름 변경 실행 — 모든 항목을 하나의 journal 엔트리로 push(단일 Ctrl+Z 복원).
/// 충돌이 하나라도 있으면 아무것도 바꾸지 않고 에러. 중간 실패 시 이미 변경된 것 롤백.
pub async fn batch_rename_execute(
    fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    rule: RenameRule,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    let location = validate_same_dir(&items)?;
    let names: Vec<String> = items.iter().map(|it| it.name.clone()).collect();
    let mapping = compute_batch_mapping(fs, &location, &names, &rule).await;
    if mapping.iter().any(|(_, _, c)| *c) {
        return Err(DuetError::Io(
            "batch rename: name collision — resolve before applying".into(),
        ));
    }
    // no-op(이름 동일) 제외하고 실제 변경 대상만 추림.
    let mut froms = Vec::new();
    let mut tos = Vec::new();
    for (old, new, _) in &mapping {
        if old != new {
            froms.push(location.path.join(old));
            tos.push(location.path.join(new));
        }
    }
    if froms.is_empty() {
        return Err(DuetError::Io("batch rename: nothing to rename".into()));
    }
    // 단일패스 rename (new==old 겹침을 위에서 차단했으므로 순서 무관하게 안전).
    // 중간 실패 시 성공분을 역순 롤백.
    for i in 0..froms.len() {
        if let Err(e) = fs.rename(&froms[i], &tos[i]).await {
            for j in (0..i).rev() {
                let _ = fs.rename(&tos[j], &froms[j]).await;
            }
            return Err(e);
        }
    }
    let pairs: Vec<RenamePair> = froms
        .iter()
        .zip(tos.iter())
        .map(|(f, t)| RenamePair {
            current: t.clone(),
            original: f.clone(),
        })
        .collect();
    ctx.journal
        .push(
            OpKind::BatchRename {
                count: pairs.len() as u32,
                location: location.clone(),
            },
            UndoAction::UndoBatchRename {
                source: location.source,
                pairs,
            },
        )
        .await
}

pub async fn mkdir(
    fs: &dyn FileSystem,
    parent: Location,
    name: String,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    if name.contains('/') || name.is_empty() {
        return Err(DuetError::Io(format!("invalid name: {name}")));
    }
    let path = parent.path.join(&name);
    fs.mkdir(&path).await?;
    ctx.journal
        .push(
            OpKind::Mkdir {
                path: path.clone(),
                source: parent.source.clone(),
            },
            UndoAction::UndoMkdir {
                source: parent.source,
                path,
            },
        )
        .await
}

// === Helpers ===

/// backup 이름 선택 — 같은 timestamp 충돌 시 .<n> suffix retry.
pub(crate) async fn pick_backup_path(
    fs: &dyn FileSystem,
    parent: &std::path::Path,
    original_name: &str,
) -> Result<PathBuf, DuetError> {
    let base = backup_name(original_name);
    let mut candidate = parent.join(&base);
    if fs.metadata(&candidate).await.is_err() {
        return Ok(candidate);
    }
    for n in 2..=6 {
        candidate = parent.join(format!("{base}.{n}"));
        if fs.metadata(&candidate).await.is_err() {
            return Ok(candidate);
        }
    }
    Err(DuetError::Io(format!(
        "backup name collision (>5 retries) for {original_name}"
    )))
}

/// Same-host SSH copy — server-side rsync 또는 cp exec.
///
/// 1. ConnectionPool 에서 active session 가져옴 — src 측 connection 사용.
///    (user 가 다를 수 있는데 src 의 권한으로 dst 까지 읽기/쓰기 되어야 함;
///    안 되면 cp/rsync 가 자연 실패)
/// 2. rsync 캐시 확인 → 없으면 exec("command -v rsync") detect
/// 3. SFTP rename 으로 dst 충돌 backup (MVP-2 와 동일)
/// 4. exec_streaming 으로 rsync/cp 실행 + progress 파싱 emit
/// 5. exit !=0 → DuetError::Ssh(stderr) hard error
///
/// 락 획득 순서: rsync_available → session (역방향 금지 — 데드락 회피).
async fn copy_execute_same_host(
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    use crate::core::copy_progress::parse_rsync_progress2_line;
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::{exec, exec_streaming};

    // src_source 에서 connection_id 추출
    let SourceId::Ssh { connection_id, .. } = &plan.src_source else {
        return Err(DuetError::Io("same_host_copy on non-ssh source".into()));
    };
    let pool = ctx
        .pool
        .as_ref()
        .ok_or_else(|| DuetError::Io("OpCtx.pool required for same-host copy".into()))?;

    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;

    // rsync detect (캐시) — 락 순서: rsync_available → session
    let use_rsync = {
        let mut cache = conn.rsync_available.lock().await;
        match *cache {
            Some(v) => v,
            None => {
                let handle = session_mutex.lock().await;
                let detected = match exec(&handle, "command -v rsync").await {
                    Ok(out) => out.exit_status == 0,
                    Err(_) => false,
                };
                *cache = Some(detected);
                detected
            }
        }
    };

    // dst 측 충돌 감지 + backup (SFTP)
    let dst_conn = pool.get(connection_id).await?;
    let dst_fs = crate::fs::SshFs::new(dst_conn);

    let mut backups = Vec::new();
    let mut copied = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());
    for it in &plan.items {
        // 항목 경계 cancel check (backup pre-loop)
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let step: Result<(), DuetError> = async {
            let dst_path = plan.dst.path.join(&it.name);
            if dst_fs.metadata(&dst_path).await.is_ok() {
                let backup = pick_backup_path(&dst_fs, &plan.dst.path, &it.name).await?;
                dst_fs.rename(&dst_path, &backup).await?;
                backups.push(BackupRestore {
                    backup_path: backup,
                    original_path: dst_path,
                });
            }
            Ok(())
        }
        .await;
        if let Err(e) = step {
            outcome = Err(e);
            break;
        }
    }

    for it in &plan.items {
        // backup 루프가 중간 실패했으면 copy 진행 안 함 (부분 backup 상태로 복사 금지).
        if outcome.is_err() {
            break;
        }
        // 항목 경계 cancel check (copy main loop)
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let step: Result<(), DuetError> = async {
            let src_path = it.location.path.join(&it.name);
            let dst_path = plan.dst.path.join(&it.name);
            let src_arg = shell_escape_path(&src_path)?;

            let cmd = if use_rsync {
                // rsync 는 SRC(trailing-slash 없음) 를 DEST *디렉토리* 안에 basename
                // 으로 생성한다. 따라서 dst.path.join(name) (= 최종 경로) 을 주면
                // dir 복사 시 한 단계 더 중첩됨 (dst/many/many/). 부모 디렉토리
                // (plan.dst.path) 를 줘야 dst/<name> 으로 떨어진다 — file/dir 동일.
                let dst_parent_arg = shell_escape_path(&plan.dst.path)?;
                format!("rsync -a --info=progress2 -- {src_arg} {dst_parent_arg}")
            } else {
                // cp 는 DEST 를 새 이름으로 취급 → 최종 경로를 그대로 준다.
                let dst_arg = shell_escape_path(&dst_path)?;
                format!("cp -a -- {src_arg} {dst_arg}")
            };

            // progress emit throttle: 1초
            let mut last_emit = std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(2))
                .unwrap_or_else(std::time::Instant::now);
            let total_bytes = plan.total_size_bytes;
            let progress_for_cb = progress.clone();

            // TODO(perf): session_mutex 가 rsync 전체 동안 잡혀 다른 SFTP op (list,
            // metadata 등) 가 블락됨. 후속에서 exec_streaming 을 두 단계로 분리:
            // (1) lock 잡고 channel_open_session 만 → (2) lock 풀고 channel 위에
            // wait loop. MVP-3 v1 은 modal 안에서 사용자 대기라 acceptable.
            let exec_result = {
                let handle = session_mutex.lock().await;
                exec_streaming(&handle, &cmd, |line| {
                    if let Some(p) = parse_rsync_progress2_line(line) {
                        let now = std::time::Instant::now();
                        let is_final = p.percent == 100;
                        if is_final
                            || now.duration_since(last_emit) >= std::time::Duration::from_secs(1)
                        {
                            last_emit = now;
                            if let Some(emitter) = &progress_for_cb {
                                emitter.emit(crate::services::task_events::ProgressInfo {
                                    bytes_done: p.bytes_done,
                                    bytes_total: if total_bytes > 0 {
                                        Some(total_bytes)
                                    } else {
                                        None
                                    },
                                    speed_bps: Some(p.speed_bps),
                                    eta_sec: Some(p.eta_sec),
                                    percent: Some(p.percent),
                                });
                            }
                        }
                    }
                })
                .await
            };

            // exec/rsync 결과 — connection loss 면 1회 retry
            let (exit, stderr) = match exec_result {
                Ok(result) => result,
                Err(e) if crate::services::retry::is_retryable_error(&e) => {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if cancel_token.is_cancelled() {
                        return Err(DuetError::Cancelled);
                    }
                    let handle = session_mutex.lock().await;
                    exec_streaming(&handle, &cmd, |_| {}).await?
                }
                Err(e) => return Err(e),
            };

            if exit != 0 {
                return Err(DuetError::Ssh(format!(
                    "{} failed (exit {}): {}",
                    if use_rsync { "rsync" } else { "cp" },
                    exit,
                    String::from_utf8_lossy(&stderr).trim()
                )));
            }
            copied.push(dst_path);
            Ok(())
        }
        .await;
        if let Err(e) = step {
            outcome = Err(e);
            break;
        }
    }

    // §4 (A4): 충돌 backup + 부분 복사분이라도 journal 에 기록한 뒤 에러 전파 —
    // backup 후 copy 실패 시 .bak 고아 + undo 미기록(Ctrl+Z 복원 불가) 버그 수정.
    if copied.is_empty() && backups.is_empty() {
        outcome?;
        return Err(DuetError::Io("copy affected nothing".into()));
    }
    let count = copied.len() as u32;
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    let entry = ctx.journal.push(op, undo).await?;
    outcome?;
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use std::path::PathBuf;
    use tempfile::TempDir;

    fn mk_target(parent: &std::path::Path, name: &str) -> EntryRef {
        EntryRef {
            location: Location {
                source: SourceId::Local,
                path: parent.to_path_buf(),
            },
            name: name.to_string(),
        }
    }

    async fn mk_ctx() -> (OpCtx, TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let settings =
            crate::services::settings::SettingsStore::load_from(&dir.path().join("s.toml"))
                .await
                .unwrap();
        let journal = crate::services::journal::Journal::load_from(&dir.path().join("j.jsonl"))
            .await
            .unwrap();
        (
            OpCtx {
                settings,
                journal,
                pool: None,
                app: None,
            },
            dir,
        )
    }

    #[tokio::test]
    async fn delete_plan_aggregates_size() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"hello")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("b"), b"world!")
            .await
            .unwrap();
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();
        let plan = delete_plan(
            &local,
            vec![mk_target(&parent, "a"), mk_target(&parent, "b")],
            DeleteMode::Trash,
        )
        .await
        .unwrap();
        assert_eq!(plan.total_count, 2);
        assert_eq!(plan.total_size_bytes, 5 + 6);
    }

    #[tokio::test]
    async fn delete_plan_empty_targets_errors() {
        let local = LocalFs::new();
        assert!(delete_plan(&local, vec![], DeleteMode::Trash)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn permanent_delete_blocked_when_settings_off() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"x").await.unwrap();
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();
        let plan = delete_plan(&local, vec![mk_target(&parent, "a")], DeleteMode::Permanent)
            .await
            .unwrap();

        let (ctx, _ctx_dir) = mk_ctx().await;
        let result = delete_execute(&local, plan, &ctx, "delete").await;
        assert!(matches!(result, Err(DuetError::NotPermitted)));
        assert!(dir.path().join("a").exists());
    }

    #[tokio::test]
    async fn permanent_delete_requires_confirm_word() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"x").await.unwrap();
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();

        let mk_plan = || async {
            delete_plan(&local, vec![mk_target(&parent, "a")], DeleteMode::Permanent)
                .await
                .unwrap()
        };

        let (ctx, _d) = mk_ctx().await;
        // 영구삭제 활성화 (단어 검증만 분리해 테스트).
        ctx.settings
            .apply(crate::services::settings::SettingsPatch {
                permanent_delete_enabled: Some(true),
                ..Default::default()
            })
            .await
            .unwrap();

        // 틀린 단어 → 거부, 파일 보존.
        let bad = delete_execute(&local, mk_plan().await, &ctx, "wrong").await;
        assert!(matches!(bad, Err(DuetError::NotPermitted)));
        assert!(dir.path().join("a").exists());

        // 올바른 단어 → 삭제.
        let ok = delete_execute(&local, mk_plan().await, &ctx, "delete").await;
        assert!(ok.is_ok());
        assert!(!dir.path().join("a").exists());
    }

    /// 2번째 trash 호출에서 실패하는 mock — 부분실패 저널 기록(§4, A1) 검증용.
    #[derive(Default)]
    struct FailingTrashFs {
        trash_calls: std::sync::Mutex<u32>,
    }

    #[async_trait::async_trait]
    impl FileSystem for FailingTrashFs {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        async fn list(&self, _: &std::path::Path) -> Result<Vec<crate::types::Entry>, DuetError> {
            unimplemented!()
        }
        async fn metadata(
            &self,
            _: &std::path::Path,
        ) -> Result<crate::types::EntryMeta, DuetError> {
            unimplemented!()
        }
        async fn rename(&self, _: &std::path::Path, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn mkdir(&self, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn trash(&self, _p: &std::path::Path, _b: &str) -> Result<TrashLocation, DuetError> {
            let mut n = self.trash_calls.lock().unwrap();
            *n += 1;
            if *n >= 2 {
                Err(DuetError::Io("trash boom".into()))
            } else {
                Ok(TrashLocation::Local {
                    trash_id: format!("t{n}"),
                })
            }
        }
        async fn remove(&self, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn restore_from_trash(
            &self,
            _: &TrashLocation,
            _: &std::path::Path,
        ) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn read_full(&self, _: &std::path::Path) -> Result<Vec<u8>, DuetError> {
            unimplemented!()
        }
        async fn write_full(&self, _: &std::path::Path, _: &[u8]) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn open_read(
            &self,
            _: &std::path::Path,
            _: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            unimplemented!()
        }
        async fn open_write(
            &self,
            _: &std::path::Path,
            _: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn delete_partial_failure_journals_completed_items() {
        let dir = TempDir::new().unwrap();
        let parent = dir.path().to_path_buf();
        let plan = DeletePlan {
            mode: DeleteMode::Trash,
            targets: vec![
                mk_target(&parent, "a"),
                mk_target(&parent, "b"),
                mk_target(&parent, "c"),
            ],
            total_size_bytes: 0,
            total_count: 3,
            source: SourceId::Local,
            source_location: Location {
                source: SourceId::Local,
                path: parent,
            },
        };
        let (ctx, _d) = mk_ctx().await;
        let fs = FailingTrashFs::default();
        let result = delete_execute(&fs, plan, &ctx, "").await;
        assert!(result.is_err(), "2번째 항목 실패로 에러여야 함");
        let hist = ctx.journal.history(10).await;
        assert_eq!(hist.len(), 1, "부분 진행분이 journal 에 1건 기록되어야 함");
        match &hist[0].undo {
            UndoAction::RestoreFromTrash { items, .. } => {
                assert_eq!(items.len(), 1, "첫 항목만 휴지통으로 갔어야 함");
            }
            other => panic!("expected RestoreFromTrash, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn copy_partial_failure_journals_completed_items() {
        use crate::core::copy_strategy::CopyStrategy;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(&src).await.unwrap();
        tokio::fs::create_dir_all(&dst).await.unwrap();
        tokio::fs::write(src.join("a"), b"hello").await.unwrap();
        // "b" 는 일부러 안 만듦 → 2번째 복사가 실패.

        let items = vec![
            EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: src.clone(),
                },
                name: "a".into(),
            },
            EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: src.clone(),
                },
                name: "b".into(),
            },
        ];
        let plan = CopyPlan {
            src_source: SourceId::Local,
            dst: Location {
                source: SourceId::Local,
                path: dst.clone(),
            },
            items,
            conflicts: vec![],
            total_size_bytes: 5,
            strategy: CopyStrategy::LocalToLocal,
        };
        let (ctx, _d) = mk_ctx().await;
        let local = LocalFs::new();
        let result = copy_execute(
            &local,
            &local,
            plan,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;
        assert!(result.is_err(), "두 번째(없는 파일) 복사가 실패해야 함");
        assert!(dst.join("a").exists(), "첫 파일은 복사됐어야 함");
        let hist = ctx.journal.history(10).await;
        assert_eq!(hist.len(), 1, "부분 복사분이 journal 에 기록되어야 함");
        match &hist[0].undo {
            UndoAction::UndoCopy { copied, .. } => assert_eq!(copied.len(), 1),
            other => panic!("expected UndoCopy, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn move_partial_failure_journals_completed_items() {
        use crate::core::copy_strategy::CopyStrategy;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(&src).await.unwrap();
        tokio::fs::create_dir_all(&dst).await.unwrap();
        tokio::fs::write(src.join("a"), b"hello").await.unwrap();

        let items = vec![
            EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: src.clone(),
                },
                name: "a".into(),
            },
            EntryRef {
                location: Location {
                    source: SourceId::Local,
                    path: src.clone(),
                },
                name: "b".into(),
            },
        ];
        let plan = MovePlan {
            src_source: SourceId::Local,
            dst: Location {
                source: SourceId::Local,
                path: dst.clone(),
            },
            items,
            conflicts: vec![],
            is_same_fs: true,
            total_size_bytes: 5,
            strategy: CopyStrategy::LocalToLocal,
        };
        let (ctx, _d) = mk_ctx().await;
        let local = LocalFs::new();
        let result = move_execute(
            &local,
            &local,
            plan,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;
        assert!(result.is_err(), "두 번째(없는 파일) 이동이 실패해야 함");
        assert!(dst.join("a").exists(), "첫 파일은 이동됐어야 함");
        assert!(!src.join("a").exists(), "원본은 사라졌어야 함");
        let hist = ctx.journal.history(10).await;
        assert_eq!(hist.len(), 1, "부분 이동분이 journal 에 기록되어야 함");
        match &hist[0].undo {
            UndoAction::UndoMove { moved, .. } => assert_eq!(moved.len(), 1),
            other => panic!("expected UndoMove, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn copy_plan_same_host_ssh_now_uses_ssh_same_host_strategy() {
        use crate::core::copy_strategy::CopyStrategy;
        use crate::types::ConnectionId;
        use std::net::Ipv4Addr;

        let local = LocalFs::new();
        let src = SourceId::Ssh {
            connection_id: ConnectionId("a".into()),
            host_ip: std::net::IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
            user: "u".into(),
        };
        let dst_src = src.clone();

        let item = EntryRef {
            location: Location {
                source: src,
                path: PathBuf::from("/x"),
            },
            name: "f".into(),
        };
        let dst = Location {
            source: dst_src,
            path: PathBuf::from("/y"),
        };

        // metadata 호출은 LocalFs 가 받지만 path 가 존재 안 해서 unwrap_or(0).
        // strategy 결정만 검증.
        let plan = copy_plan(&local, &local, vec![item], dst).await.unwrap();
        assert_eq!(plan.strategy, CopyStrategy::SshSameHost);
    }

    #[tokio::test]
    async fn copy_plan_detects_conflict() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"new")
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join("dst")).await.unwrap();
        tokio::fs::write(dir.path().join("dst/a"), b"existing")
            .await
            .unwrap();

        let local = LocalFs::new();
        let item = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: dir.path().to_path_buf(),
            },
            name: "a".into(),
        };
        let dst = Location {
            source: SourceId::Local,
            path: dir.path().join("dst"),
        };
        let plan = copy_plan(&local, &local, vec![item], dst).await.unwrap();
        assert_eq!(plan.conflicts.len(), 1);
        assert_eq!(plan.conflicts[0].name, "a");
    }

    #[tokio::test]
    async fn rename_works_and_journals() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a"), b"x").await.unwrap();
        let local = LocalFs::new();
        let (ctx, _ctx_dir) = mk_ctx().await;
        let target = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: dir.path().to_path_buf(),
            },
            name: "a".into(),
        };
        let entry = rename(&local, target, "b".into(), &ctx).await.unwrap();
        assert!(dir.path().join("b").exists());
        assert!(matches!(entry.undo, UndoAction::UndoRename { .. }));
    }

    #[tokio::test]
    async fn sync_mirrors_new_and_changed_then_undo_restores() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("new.txt"), b"fresh").unwrap();
        std::fs::write(src.join("sub/x.txt"), b"deep").unwrap();
        std::fs::write(src.join("same.txt"), b"keep").unwrap();
        // dst 에 same.txt 동일 내용 + changed.txt 다른 내용(원본 src 에 존재).
        std::fs::write(src.join("changed.txt"), b"NEW-content").unwrap();
        std::fs::write(dst.join("changed.txt"), b"old").unwrap();

        let fs = LocalFs::new();
        let (ctx, _cd) = mk_ctx().await;
        let mk_loc = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let plan = sync_plan(&fs, &fs, mk_loc(&src), mk_loc(&dst))
            .await
            .unwrap();
        let entry = sync_execute(
            &fs,
            &fs,
            plan,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        // dst 가 src 를 반영.
        assert_eq!(std::fs::read(dst.join("new.txt")).unwrap(), b"fresh");
        assert_eq!(std::fs::read(dst.join("sub/x.txt")).unwrap(), b"deep");
        assert_eq!(
            std::fs::read(dst.join("changed.txt")).unwrap(),
            b"NEW-content"
        );

        // undo: 새로 만든 파일 제거 + 덮어쓴 파일 복원.
        let pool = Arc::new(crate::services::connection_pool::ConnectionPool::new());
        let outcome = crate::core::undo::execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, crate::core::undo::UndoKind::Ok));
        assert!(
            !dst.join("new.txt").exists(),
            "created file removed on undo"
        );
        assert_eq!(
            std::fs::read(dst.join("changed.txt")).unwrap(),
            b"old",
            "overwritten file restored from backup"
        );
    }

    #[tokio::test]
    async fn sync_plan_rejects_same_dir() {
        let dir = TempDir::new().unwrap();
        let fs = LocalFs::new();
        let loc = Location {
            source: SourceId::Local,
            path: dir.path().to_path_buf(),
        };
        let r = sync_plan(&fs, &fs, loc.clone(), loc).await;
        assert!(matches!(r, Err(DuetError::Io(_))));
    }

    #[tokio::test]
    async fn merge_bidir_copies_both_ways_skips_conflict_then_undo() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("only_l.txt"), b"L").unwrap();
        std::fs::write(r.join("only_r.txt"), b"R").unwrap();
        // 충돌: 양쪽 다른 내용 — 절대 안 건드려야 함.
        std::fs::write(l.join("conf.txt"), b"left-content").unwrap();
        std::fs::write(r.join("conf.txt"), b"RIGHT").unwrap();

        let fs = LocalFs::new();
        let (ctx, _cd) = mk_ctx().await;
        let mk = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let entry = merge_bidir(
            &fs,
            mk(&l),
            &fs,
            mk(&r),
            false,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        // 한쪽 전용 파일이 반대편에 생김.
        assert_eq!(std::fs::read(r.join("only_l.txt")).unwrap(), b"L");
        assert_eq!(std::fs::read(l.join("only_r.txt")).unwrap(), b"R");
        // 충돌 파일은 양쪽 그대로 (덮어쓰지 않음).
        assert_eq!(std::fs::read(l.join("conf.txt")).unwrap(), b"left-content");
        assert_eq!(std::fs::read(r.join("conf.txt")).unwrap(), b"RIGHT");

        // undo — 새로 복사된 것만 제거, 원본/충돌 그대로.
        let pool = Arc::new(crate::services::connection_pool::ConnectionPool::new());
        let outcome = crate::core::undo::execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, crate::core::undo::UndoKind::Ok));
        assert!(!r.join("only_l.txt").exists());
        assert!(!l.join("only_r.txt").exists());
        assert!(l.join("only_l.txt").exists(), "원본은 유지");
        assert_eq!(std::fs::read(r.join("conf.txt")).unwrap(), b"RIGHT");
    }

    #[tokio::test]
    async fn mkdir_works_and_journals() {
        let dir = TempDir::new().unwrap();
        let local = LocalFs::new();
        let (ctx, _ctx_dir) = mk_ctx().await;
        mkdir(
            &local,
            Location {
                source: SourceId::Local,
                path: dir.path().to_path_buf(),
            },
            "newdir".into(),
            &ctx,
        )
        .await
        .unwrap();
        assert!(dir.path().join("newdir").is_dir());
    }

    // === batch rename ===

    #[test]
    fn apply_rule_prefix_suffix_preserves_ext() {
        let rule = RenameRule {
            prefix: "x_".into(),
            suffix: "_v2".into(),
            ..Default::default()
        };
        assert_eq!(apply_rename_rule("photo.jpg", &rule, 0), "x_photo_v2.jpg");
        // 확장자 없는 이름.
        assert_eq!(apply_rename_rule("README", &rule, 0), "x_README_v2");
        // 선행 dot 파일은 확장자 없음 취급.
        assert_eq!(apply_rename_rule(".bashrc", &rule, 0), "x_.bashrc_v2");
    }

    #[test]
    fn apply_rule_find_replace_and_case() {
        let rule = RenameRule {
            find: " ".into(),
            replace: "_".into(),
            replace_all: true,
            case: Some(CaseOp::Lower),
            ..Default::default()
        };
        assert_eq!(
            apply_rename_rule("My Holiday Pic.PNG", &rule, 0),
            "my_holiday_pic.PNG"
        );
        let title = RenameRule {
            case: Some(CaseOp::Title),
            ..Default::default()
        };
        assert_eq!(
            apply_rename_rule("hello_world.txt", &title, 0),
            "Hello_World.txt"
        );
    }

    #[test]
    fn apply_rule_sequence_with_base() {
        let rule = RenameRule {
            base: Some("img".into()),
            seq: Some(SeqRule {
                start: 1,
                step: 1,
                padding: 3,
                position: SeqPos::Suffix,
            }),
            ..Default::default()
        };
        assert_eq!(apply_rename_rule("a.png", &rule, 0), "img001.png");
        assert_eq!(apply_rename_rule("b.png", &rule, 1), "img002.png");
    }

    #[tokio::test]
    async fn batch_rename_preview_flags_collisions() {
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a.txt"), b"")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("b.txt"), b"")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("existing.txt"), b"")
            .await
            .unwrap();
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();
        // 두 항목 모두 "existing" 으로 → 배치 내 중복 + 기존 파일 충돌.
        let rule = RenameRule {
            base: Some("existing".into()),
            ..Default::default()
        };
        let plan = batch_rename_preview(
            &local,
            vec![mk_target(&parent, "a.txt"), mk_target(&parent, "b.txt")],
            rule,
        )
        .await
        .unwrap();
        assert!(plan.has_collision);
        assert!(plan.items.iter().all(|it| it.collision));
    }

    #[tokio::test]
    async fn batch_rename_execute_then_single_undo_restores_all() {
        let dir = TempDir::new().unwrap();
        for n in ["a.txt", "b.txt", "c.txt"] {
            tokio::fs::write(dir.path().join(n), b"x").await.unwrap();
        }
        let local = LocalFs::new();
        let parent = dir.path().to_path_buf();
        let (ctx, _cd) = mk_ctx().await;
        let rule = RenameRule {
            prefix: "p_".into(),
            ..Default::default()
        };
        let entry = batch_rename_execute(
            &local,
            vec![
                mk_target(&parent, "a.txt"),
                mk_target(&parent, "b.txt"),
                mk_target(&parent, "c.txt"),
            ],
            rule,
            &ctx,
        )
        .await
        .unwrap();
        for n in ["p_a.txt", "p_b.txt", "p_c.txt"] {
            assert!(dir.path().join(n).exists(), "{n} should exist");
        }
        assert!(!dir.path().join("a.txt").exists());
        // 단일 엔트리 — pairs 3개.
        match &entry.undo {
            UndoAction::UndoBatchRename { pairs, .. } => assert_eq!(pairs.len(), 3),
            other => panic!("expected UndoBatchRename, got {other:?}"),
        }
        // undo 로 전체 복원.
        let pool = Arc::new(crate::services::connection_pool::ConnectionPool::new());
        let outcome = crate::core::undo::execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, crate::core::undo::UndoKind::Ok));
        for n in ["a.txt", "b.txt", "c.txt"] {
            assert!(dir.path().join(n).exists(), "{n} restored");
        }
        assert!(!dir.path().join("p_a.txt").exists());
    }

    /// apply_compare(local): 생성 + 덮어쓰기(백업) 혼합 후 undo 로 완전 복원.
    #[tokio::test]
    async fn apply_compare_creates_and_overwrites_then_undo() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("only_l.txt"), b"L").unwrap(); // ToRight → 생성
        std::fs::write(r.join("only_r.txt"), b"R").unwrap(); // ToLeft → 생성
        std::fs::write(l.join("both.txt"), b"left-new").unwrap();
        std::fs::write(r.join("both.txt"), b"right-old").unwrap(); // ToRight → 덮어쓰기(백업)

        let fs = LocalFs::new();
        let (ctx, _cd) = mk_ctx().await;
        let mk = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let decisions = vec![
            ApplyDecision {
                rel: "only_l.txt".into(),
                direction: ApplyDirection::ToRight,
            },
            ApplyDecision {
                rel: "only_r.txt".into(),
                direction: ApplyDirection::ToLeft,
            },
            ApplyDecision {
                rel: "both.txt".into(),
                direction: ApplyDirection::ToRight,
            },
        ];
        let entry = apply_compare(
            &fs,
            mk(&l),
            &fs,
            mk(&r),
            decisions,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read(r.join("only_l.txt")).unwrap(), b"L");
        assert_eq!(std::fs::read(l.join("only_r.txt")).unwrap(), b"R");
        // 덮어써져 right both.txt = left 내용.
        assert_eq!(std::fs::read(r.join("both.txt")).unwrap(), b"left-new");
        match &entry.op {
            OpKind::CompareApply {
                applied,
                overwritten,
                ..
            } => {
                assert_eq!(*applied, 3);
                assert_eq!(*overwritten, 1);
            }
            other => panic!("expected CompareApply, got {other:?}"),
        }

        // undo — 생성분 제거 + 덮어쓴 백업 복원.
        let pool = Arc::new(crate::services::connection_pool::ConnectionPool::new());
        let outcome = crate::core::undo::execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, crate::core::undo::UndoKind::Ok));
        assert!(!r.join("only_l.txt").exists(), "생성분 제거");
        assert!(!l.join("only_r.txt").exists(), "생성분 제거");
        assert_eq!(
            std::fs::read(r.join("both.txt")).unwrap(),
            b"right-old",
            "덮어쓴 파일은 백업에서 복원"
        );
        assert!(l.join("only_l.txt").exists(), "원본 유지");
    }

    /// dst 가 이미 있으면 skip 방향이어도 안 건드림 — Skip 결정은 작업에서 제외.
    #[tokio::test]
    async fn apply_compare_skip_is_excluded() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("a.txt"), b"L").unwrap();

        let fs = LocalFs::new();
        let (ctx, _cd) = mk_ctx().await;
        let mk = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let entry = apply_compare(
            &fs,
            mk(&l),
            &fs,
            mk(&r),
            vec![ApplyDecision {
                rel: "a.txt".into(),
                direction: ApplyDirection::Skip,
            }],
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert!(!r.join("a.txt").exists(), "skip 은 적용 안 됨");
        match &entry.op {
            OpKind::CompareApply { applied, .. } => assert_eq!(*applied, 0),
            other => panic!("expected CompareApply, got {other:?}"),
        }
    }

    /// trash_usage(local): OS 휴지통이라 측정 비대상(available=false).
    #[tokio::test]
    async fn trash_usage_local_unavailable() {
        let pool = Arc::new(crate::services::connection_pool::ConnectionPool::new());
        let u = trash_usage(&SourceId::Local, &pool).await.unwrap();
        assert!(!u.available);
        assert_eq!(u.bytes, 0);
    }

    /// detect_renames(local): 이동된 파일을 LeftOnly+RightOnly 가 아니라 move 로 인식.
    #[tokio::test]
    async fn detect_renames_local_pairs_move() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        // 같은 내용을 left=old.txt, right=new.txt 로 — 이동.
        std::fs::write(l.join("old.txt"), b"moved-content").unwrap();
        std::fs::write(r.join("new.txt"), b"moved-content").unwrap();
        // 진짜 한쪽전용(내용 다름) — 이동 아님.
        std::fs::write(l.join("only.txt"), b"unique-left").unwrap();

        let fs = LocalFs::new();
        let loc = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let mut plan = crate::core::compare::compare_dirs(&fs, loc(&l), &fs, loc(&r))
            .await
            .unwrap();
        // 감지 전: old.txt(LeftOnly), new.txt(RightOnly), only.txt(LeftOnly).
        assert_eq!(plan.left_only, 2);
        assert_eq!(plan.right_only, 1);

        let moved = detect_renames(&mut plan, &fs, &fs, None).await.unwrap();
        assert!(moved.contains("old.txt") && moved.contains("new.txt"));
        assert_eq!(plan.moves.len(), 1);
        assert_eq!(plan.moves[0].from_rel, "old.txt");
        assert_eq!(plan.moves[0].to_rel, "new.txt");
        // 이동 쌍은 entries 에서 빠지고 카운트도 보정 — only.txt 만 LeftOnly 로 남음.
        assert_eq!(plan.left_only, 1);
        assert_eq!(plan.right_only, 0);
        assert!(plan
            .entries
            .iter()
            .all(|e| e.rel != "old.txt" && e.rel != "new.txt"));
        assert!(plan.entries.iter().any(|e| e.rel == "only.txt"));
    }

    /// sync_preview(local): 복사 대상(신규/변경) + prune 대상(dst 전용) 산출.
    #[tokio::test]
    async fn sync_preview_local_lists() {
        let dir = TempDir::new().unwrap();
        let s = dir.path().join("S");
        let d = dir.path().join("D");
        std::fs::create_dir_all(&s).unwrap();
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(s.join("new.txt"), b"n").unwrap(); // dst 없음 → 복사
        std::fs::write(s.join("same.txt"), b"x").unwrap();
        std::fs::write(d.join("same.txt"), b"x").unwrap(); // 동일 → skip
        std::fs::write(s.join("chg.txt"), b"aaaa").unwrap();
        std::fs::write(d.join("chg.txt"), b"bb").unwrap(); // 크기 다름 → 복사
        std::fs::write(d.join("extra.txt"), b"e").unwrap(); // dst 전용 → prune

        let fs = LocalFs::new();
        let mk = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let p = sync_preview(&fs, &mk(&s), &fs, &mk(&d), None)
            .await
            .unwrap();
        let mut copy = p.copy.clone();
        copy.sort();
        assert_eq!(copy, vec!["chg.txt".to_string(), "new.txt".to_string()]);
        assert_eq!(p.prune, vec!["extra.txt".to_string()]);
        assert!(!p.truncated);
    }

    /// verify_compare(local): 내용 같음/다름(같은 크기)/크기 다름/없음 판정.
    #[tokio::test]
    async fn verify_compare_local_byte_compare() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("same.txt"), b"hello").unwrap();
        std::fs::write(r.join("same.txt"), b"hello").unwrap();
        std::fs::write(l.join("diff.txt"), b"aaaaa").unwrap(); // 같은 크기, 다른 내용
        std::fs::write(r.join("diff.txt"), b"bbbbb").unwrap();
        std::fs::write(l.join("size.txt"), b"short").unwrap(); // 크기 다름
        std::fs::write(r.join("size.txt"), b"longer-content").unwrap();
        std::fs::write(l.join("only_l.txt"), b"x").unwrap(); // 한쪽 없음

        let fs = LocalFs::new();
        let mk = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let res = verify_compare(
            &fs,
            &mk(&l),
            &fs,
            &mk(&r),
            vec![
                "same.txt".into(),
                "diff.txt".into(),
                "size.txt".into(),
                "only_l.txt".into(),
            ],
            None,
        )
        .await
        .unwrap();
        let by = |rel: &str| res.iter().find(|v| v.rel == rel).unwrap().equal;
        assert_eq!(by("same.txt"), Some(true));
        assert_eq!(by("diff.txt"), Some(false), "같은 크기·다른 내용 → 다름");
        assert_eq!(by("size.txt"), Some(false), "크기 다름 → 다름");
        assert_eq!(by("only_l.txt"), None, "한쪽 없음 → 검증 불가");
    }

    // prune_pass 의 src 존재 판정 검증용 최소 mock — metadata/list/trash 만 구현.
    #[derive(Clone, Copy)]
    enum MetaKind {
        Missing, // NotFound — '삭제됨' → prune 대상
        Flaky,   // 일시적 Ssh 오류 — prune 금지(전파)
    }
    struct PruneMock {
        meta: std::collections::HashMap<PathBuf, MetaKind>,
        listing: Vec<crate::types::Entry>,
        trashed: std::sync::Mutex<Vec<PathBuf>>,
    }
    #[async_trait::async_trait]
    impl FileSystem for PruneMock {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        async fn list(
            &self,
            _path: &std::path::Path,
        ) -> Result<Vec<crate::types::Entry>, DuetError> {
            Ok(self.listing.clone())
        }
        async fn metadata(
            &self,
            path: &std::path::Path,
        ) -> Result<crate::types::EntryMeta, DuetError> {
            match self.meta.get(path) {
                Some(MetaKind::Missing) | None => {
                    Err(DuetError::NotFound(path.display().to_string()))
                }
                Some(MetaKind::Flaky) => Err(DuetError::Ssh("transient".into())),
            }
        }
        async fn trash(
            &self,
            path: &std::path::Path,
            _batch_id: &str,
        ) -> Result<TrashLocation, DuetError> {
            self.trashed.lock().unwrap().push(path.to_path_buf());
            Ok(TrashLocation::Remote {
                trash_path: path.to_path_buf(),
            })
        }
        async fn rename(&self, _: &std::path::Path, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn mkdir(&self, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn remove(&self, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn restore_from_trash(
            &self,
            _: &TrashLocation,
            _: &std::path::Path,
        ) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn read_full(&self, _: &std::path::Path) -> Result<Vec<u8>, DuetError> {
            unimplemented!()
        }
        async fn write_full(&self, _: &std::path::Path, _: &[u8]) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn open_read(
            &self,
            _: &std::path::Path,
            _: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            unimplemented!()
        }
        async fn open_write(
            &self,
            _: &std::path::Path,
            _: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            unimplemented!()
        }
    }

    fn mock_file(name: &str) -> crate::types::Entry {
        crate::types::Entry {
            name: name.into(),
            kind: crate::types::EntryKind::File,
            size: Some(1),
            modified_ms: Some(1),
            permissions: None,
            hidden: false,
        }
    }

    /// src 가 NotFound 면 dst 를 휴지통으로 prune.
    #[tokio::test]
    async fn prune_trashes_when_src_notfound() {
        let mock = PruneMock {
            meta: std::collections::HashMap::from([(
                PathBuf::from("/S/gone.txt"),
                MetaKind::Missing,
            )]),
            listing: vec![mock_file("gone.txt")],
            trashed: std::sync::Mutex::new(Vec::new()),
        };
        let mut pruned = Vec::new();
        let r = prune_pass(
            &mock,
            std::path::Path::new("/S"),
            &mock,
            std::path::Path::new("/D"),
            &tokio_util::sync::CancellationToken::new(),
            "batch",
            &mut pruned,
        )
        .await;
        assert!(r.is_ok());
        assert_eq!(pruned.len(), 1);
        assert_eq!(
            mock.trashed.lock().unwrap().as_slice(),
            &[PathBuf::from("/D/gone.txt")]
        );
    }

    /// src metadata 가 일시적 오류면 prune 하지 않고 전파('삭제됨' 오인 금지).
    #[tokio::test]
    async fn prune_propagates_transient_error_without_trashing() {
        let mock = PruneMock {
            meta: std::collections::HashMap::from([(
                PathBuf::from("/S/flaky.txt"),
                MetaKind::Flaky,
            )]),
            listing: vec![mock_file("flaky.txt")],
            trashed: std::sync::Mutex::new(Vec::new()),
        };
        let mut pruned = Vec::new();
        let r = prune_pass(
            &mock,
            std::path::Path::new("/S"),
            &mock,
            std::path::Path::new("/D"),
            &tokio_util::sync::CancellationToken::new(),
            "batch",
            &mut pruned,
        )
        .await;
        assert!(matches!(r, Err(DuetError::Ssh(_))), "일시적 오류는 전파");
        assert!(pruned.is_empty(), "prune 안 함");
        assert!(mock.trashed.lock().unwrap().is_empty(), "휴지통 호출 없음");
    }
}
