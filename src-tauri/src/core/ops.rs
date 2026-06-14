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

pub async fn delete_execute(
    fs: &dyn FileSystem,
    plan: DeletePlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    if matches!(plan.mode, DeleteMode::Permanent) {
        let s = ctx.settings.get().await;
        if !s.permanent_delete_enabled {
            return Err(DuetError::NotPermitted);
        }
    }

    let undo = match plan.mode {
        DeleteMode::Trash => {
            let batch_id = crate::services::trash::new_batch_id();
            let mut items = Vec::new();
            for t in &plan.targets {
                let p = t.location.path.join(&t.name);
                let loc = fs.trash(&p, &batch_id).await?;
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
            UndoAction::RestoreFromTrash {
                source: plan.source.clone(),
                items,
            }
        }
        DeleteMode::Permanent => {
            for t in &plan.targets {
                let p = t.location.path.join(&t.name);
                fs.remove(&p).await?;
            }
            UndoAction::Irreversible
        }
    };

    let op = match plan.mode {
        DeleteMode::Trash => OpKind::Trash {
            count: plan.total_count,
            location: plan.source_location.clone(),
        },
        DeleteMode::Permanent => OpKind::PermanentDelete {
            count: plan.total_count,
            location: plan.source_location.clone(),
        },
    };
    ctx.journal.push(op, undo).await
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
            // relay 는 byte-level progress emit 안 함 (read_full/write_full 라
            // 라인 단위 X) — progress 인자 무시
            let _ = progress;
            copy_execute_relay(src_fs, dst_fs, plan, ctx, cancel_token).await
        }
        CopyStrategy::SshSameHost => {
            copy_execute_same_host(plan, ctx, cancel_token, progress).await
        }
    }
}

/// 기존 relay 경로 (LocalToLocal + Relay 공통).
/// 충돌 시 dst 파일을 .bak.<ts> 로 mv 후 src 를 복사.
async fn copy_execute_relay(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    let mut copied = Vec::new();
    let mut backups = Vec::new();
    for it in &plan.items {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }

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
        copied.push(dst_path);
    }

    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
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
    for it in &plan.items {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }

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
    }

    let undo = UndoAction::UndoMove {
        src_source: plan.src_source.clone(),
        dst_source: plan.dst.source.clone(),
        moved,
        backups_to_restore: backups,
    };
    let op = OpKind::Move {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
}

// === Sync (단방향 미러) ===

/// 단방향 미러 계획 — src 디렉토리 → dst 디렉토리.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SyncPlan {
    pub src: Location,
    pub dst: Location,
    pub strategy: CopyStrategy,
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
    if !matches!(strategy, CopyStrategy::LocalToLocal) {
        return Err(DuetError::NotSupported(
            "sync currently supports local↔local only (same-host SSH sync is a follow-up)".into(),
        ));
    }
    Ok(SyncPlan { src, dst, strategy })
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

/// 단방향 추가 미러 실행 — src 의 새/변경 파일을 dst 로 복사(미변경 skip).
/// 덮어쓰는 dst 파일은 `.bak.<ts>` 백업, 새로 만든 파일은 추적 → UndoCopy 로 완전 복원.
/// 삭제(prune)는 v1 미지원(추가 전용) — undo 안전.
pub async fn sync_execute(
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
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied: state.created,
        backups_to_restore: state.backups,
    };
    let op = OpKind::Sync {
        count: state.done as u32,
        src: plan.src.clone(),
        dst: plan.dst.clone(),
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
    for it in &plan.items {
        // 항목 경계 cancel check (backup pre-loop)
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let dst_path = plan.dst.path.join(&it.name);
        if dst_fs.metadata(&dst_path).await.is_ok() {
            let backup = pick_backup_path(&dst_fs, &plan.dst.path, &it.name).await?;
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path,
            });
        }
    }

    let mut copied = Vec::new();

    for it in &plan.items {
        // 항목 경계 cancel check (copy main loop)
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }

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
    }

    // Journal push (기존 schema 그대로)
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
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
        let result = delete_execute(&local, plan, &ctx).await;
        assert!(matches!(result, Err(DuetError::NotPermitted)));
        assert!(dir.path().join("a").exists());
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
}
