//! 파괴적 작업 추상화 — plan + execute 두 단계.
//!
//! plan() 결과는 IPC 노출 — UI 다이얼로그가 사용자에게 보여줌.
//! execute() 는 백엔드에서 settings/journal 갱신.

use crate::core::copy_strategy::{decide as decide_strategy, CopyStrategy};
use crate::fs::FileSystem;
use crate::services::journal::{
    BackupRestore, Journal, JournalEntry, MoveItem, OpKind, TrashItem, UndoAction,
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
async fn pick_backup_path(
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
        let dst_arg = shell_escape_path(&dst_path)?;

        let cmd = if use_rsync {
            format!("rsync -a --info=progress2 -- {src_arg} {dst_arg}")
        } else {
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
}
