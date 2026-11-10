//! 파괴적 작업 추상화 — plan + execute 두 단계.
//!
//! plan() 결과는 IPC 노출 — UI 다이얼로그가 사용자에게 보여줌.
//! execute() 는 백엔드에서 settings/journal 갱신.

use crate::core::copy_strategy::{decide_fs, CopyStrategy};
use crate::fs::{posix_path, FileSystem};
use crate::services::journal::{
    BackupRestore, ChmodItem, Journal, JournalEntry, MoveItem, OpKind, RedoCopyPair, RenamePair,
    TrashItem, UndoAction,
};
use crate::services::settings::SettingsStore;
use crate::types::{DeleteMode, DuetError, EntryRef, Location, SourceId, TrashLocation};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
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
    /// 받는 위치의 기존 항목이 **폴더**인지 — 교체의 의미가 파일과 다르다.
    /// 폴더 교체는 병합이 아니라 폴더 전체를 갈아끼우므로(기존에만 있던 파일도 사라짐)
    /// UI 가 이를 명시하고, 실행부는 되돌릴 수 있게 백업을 남긴다(§4 폴더 예외).
    pub dst_is_dir: bool,
    /// 기존(덮어써질) 대상 파일 메타 — 충돌 다이얼로그의 새↔기존 비교 표시용.
    pub dst_size: Option<u64>,
    pub dst_modified_ms: Option<i64>,
    /// 새(복사될) 소스 파일 메타 — stat 실패 시 None (plan 은 계속 유효).
    pub src_size: Option<u64>,
    pub src_modified_ms: Option<i64>,
}

/// 충돌(대상에 같은 이름 존재) 시 처리 방식 — 탐색기/파인더/TC 식. 프론트가 선택해 전달.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    /// 충돌 시 기존을 교체. 충돌 없으면 그냥 복사. copy/move 에서는 **영구 덮어쓰기라
    /// undo 불가**(2026-06 사용자 승인 §4 예외) — 실패 안전을 위해 임시백업→복사→성공 시
    /// 백업 영구삭제/실패 시 롤백하지만 성공 후 복원은 안 함. (sync/repack/three-way 의
    /// Replace 는 .bak 보존 + undo 가능 — 이 예외는 copy/move 한정.)
    #[default]
    Replace,
    /// 충돌 항목은 복사/이동 안 함 (기존 그대로).
    Skip,
    /// 새 항목을 `name (1).ext` 식 가용 이름으로 복사 (둘 다 유지).
    KeepBoth,
}

/// 대상에 이미 있는 이름을 피해 `stem (n).ext` 가용 이름을 찾는다(KeepBoth). 최대 9999회.
async fn dedup_dst_name(dst_fs: &dyn FileSystem, dir: &std::path::Path, name: &str) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        // 선두 dot(.bashrc)·끝 dot 은 확장자로 안 봄.
        Some(i) if i > 0 && i < name.len() - 1 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..=9999 {
        // 길이 한계를 넘으면 stem 을 잘라 자리를 만든다(§ suffixed_name).
        let cand = crate::fs::suffixed_name(stem, &format!(" ({n}){ext}"));
        let path = dst_fs.join(dir, &cand);
        if dst_fs.metadata(&path).await.is_err() {
            return path;
        }
    }
    // 극단적 폴백 — timestamp 로 유일화.
    dst_fs.join(
        dir,
        &crate::fs::suffixed_name(stem, &format!(" ({}){ext}", backup_name(""))),
    )
}

/// A path belongs to its source filesystem, even on a Windows client.
fn file_name_for<'a>(source: &SourceId, path: &'a Path) -> Option<&'a std::ffi::OsStr> {
    match source {
        SourceId::Local => path.file_name(),
        SourceId::Ssh { .. } => posix_path::file_name(path).map(std::ffi::OsStr::new),
    }
}

fn parent_for(source: &SourceId, path: &Path) -> Option<PathBuf> {
    match source {
        SourceId::Local => path.parent().map(Path::to_path_buf),
        SourceId::Ssh { .. } => posix_path::parent(path),
    }
}

/// `name` → `name.bak.<ts>`. timestamp 충돌 시 .<n> suffix 는 호출자가 retry.
pub fn backup_name(original: &str) -> String {
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    // 이름이 길면 앞부분을 잘라 접미사 자리를 만든다 — 안 그러면 백업 rename 이
    // "File name too long" 으로 실패해 덮어쓰기 복사 전체가 무산된다.
    crate::fs::suffixed_name(original, &format!(".bak.{ts}"))
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
        let p = fs.join(&t.location.path, &t.name);
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

/// 항목 개수 기준 진행률(삭제처럼 바이트 무관한 작업용). current_file 포함.
fn count_progress(
    done: u32,
    total: u32,
    current_file: Option<String>,
) -> crate::services::task_events::ProgressInfo {
    let percent = if total > 0 {
        (done.min(total) * 100 / total) as u8
    } else {
        0
    };
    crate::services::task_events::ProgressInfo {
        bytes_done: 0,
        bytes_total: None,
        speed_bps: None,
        eta_sec: None,
        percent: Some(percent),
        current_file,
        files_done: done,
        files_total: total,
    }
}

pub async fn delete_execute(
    fs: &dyn FileSystem,
    plan: DeletePlan,
    ctx: &OpCtx,
    confirm_word: &str,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    delete_execute_cancellable(
        fs,
        plan,
        ctx,
        confirm_word,
        progress,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
}

/// Delete with cooperative cancellation; journal completed items even when stopped or failed.
pub async fn delete_execute_cancellable(
    fs: &dyn FileSystem,
    plan: DeletePlan,
    ctx: &OpCtx,
    confirm_word: &str,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
    cancel: &tokio_util::sync::CancellationToken,
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
    let total = plan.targets.len() as u32;

    // §4: 항목별로 진행하며 누적하고, 중간 실패 시에도 '여기까지'를 journal 에 기록한 뒤
    // 에러를 전파한다. 그래야 이미 휴지통으로 옮겨진 1..N-1 항목을 Ctrl+Z 로 복원할 수 있다.
    match plan.mode {
        DeleteMode::Trash => {
            let batch_id = crate::services::trash::new_batch_id();
            // 배치 한 번 — 로컬(OS 휴지통)은 항목마다 부르면 휴지통 열거 비용이 N배로
            // 붙는다. 원격은 기본 구현이 항목별 mv 를 순차 수행(동작 동일).
            if let Some(p) = progress.as_ref() {
                p.emit(count_progress(
                    0,
                    total,
                    plan.targets.first().map(|t| t.name.clone()),
                ));
            }
            let paths: Vec<PathBuf> = plan
                .targets
                .iter()
                .map(|t| fs.join(&t.location.path, &t.name))
                .collect();
            let on_progress = |done, path: Option<std::path::PathBuf>| {
                if let Some(p) = progress.as_ref() {
                    p.emit(count_progress(
                        done,
                        total,
                        path.map(|p| {
                            file_name_for(&plan.source, &p)
                                .unwrap_or(p.as_os_str())
                                .to_string_lossy()
                                .into_owned()
                        }),
                    ));
                }
            };
            let (moved, err) = fs
                .trash_many_cancellable(&paths, &batch_id, cancel, &on_progress)
                .await;
            let outcome: Result<(), DuetError> = match err {
                Some(e) => Err(e),
                None => Ok(()),
            };
            let items: Vec<TrashItem> = moved
                .into_iter()
                .map(|(original_path, loc)| TrashItem {
                    trash_path: match &loc {
                        TrashLocation::Local { trash_id } => trash_id.clone(),
                        TrashLocation::Remote { trash_path } => {
                            trash_path.to_string_lossy().into_owned()
                        }
                    },
                    original_path,
                })
                .collect();
            if let Some(p) = progress.as_ref() {
                p.emit(count_progress(items.len() as u32, total, None));
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
            notify_partial_delete(ctx, &entry, &outcome);
            outcome?;
            Ok(entry)
        }
        DeleteMode::Permanent => {
            let mut removed = 0u32;
            let mut outcome: Result<(), DuetError> = Ok(());
            for (idx, t) in plan.targets.iter().enumerate() {
                if cancel.is_cancelled() {
                    outcome = Err(DuetError::Cancelled);
                    break;
                }
                if let Some(p) = progress.as_ref() {
                    p.emit(count_progress(idx as u32, total, Some(t.name.clone())));
                }
                let p = fs.join(&t.location.path, &t.name);
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
            notify_partial_delete(ctx, &entry, &outcome);
            outcome?;
            Ok(entry)
        }
    }
}

// Failed/cancelled tasks do not reach the command's success notification. Expose the
// partial journal immediately so History and Undo stay in sync with completed items.
fn notify_partial_delete(ctx: &OpCtx, entry: &JournalEntry, outcome: &Result<(), DuetError>) {
    if outcome.is_ok() {
        return;
    }
    if let Some(app) = &ctx.app {
        use tauri_specta::Event;
        let _ = crate::services::journal_events::JournalChangedEvent {
            entry: entry.clone(),
            change: "push".into(),
        }
        .emit(app);
    }
}

// === Copy ===

/// plan 단계에서 총 바이트 측정에 허용하는 시간. 넘기면 "미상"(0)으로 두고 확인
/// 다이얼로그를 먼저 띄운다 — 사용자를 기다리게 하는 것보다 분모가 늦게 채워지는 게 낫다.
const MEASURE_BUDGET: std::time::Duration = std::time::Duration::from_millis(400);
/// execute 시작 시 분모를 채우는 재측정 예산 — 넘기면 분모 없이 바로 복사를 시작한다.
/// (다이얼로그 때보다 넉넉하다: 이미 진행 모달이 떠 있어 "작업 중"으로 보인다.)
const EXECUTE_MEASURE_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);

pub async fn copy_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
) -> Result<CopyPlan, DuetError> {
    plan_transfer(src_fs, dst_fs, items, dst, true).await
}

/// copy/move 공통 plan — 충돌 목록 + (선택적) 총 바이트.
///
/// `measure_total=false` 면 `dir_size` 재귀 스캔을 건너뛰고 총량을 0(=미상)으로 둔다.
/// 스캔은 대용량 트리에서 확인 다이얼로그가 뜨기까지의 지연 그 자체라, 총량이 실제로
/// 필요 없는 경우(same-fs 이동=rename)엔 치르지 않는다.
///
/// `measure_total=true` 여도 **시간 상자**(`MEASURE_BUDGET`) 안에서만 잰다 — 예산을
/// 넘기면 미상(0)으로 두고 다이얼로그를 먼저 띄운다. 분모는 execute 가 시작할 때
/// `measure_total_bytes` 로 채운다(진행 모달이 이미 떠 있는 시점).
async fn plan_transfer(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
    measure_total: bool,
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
    // 폴더를 자기 자신/하위로 — 끝없는 자기 복제를 시작 전에 거부(fileops-04).
    ensure_items_not_into_dst(src_fs, &src_source, &items, dst_fs, &dst).await?;

    let mut conflicts = Vec::new();
    let mut total = 0u64;
    for it in &items {
        let dst_path = dst_fs.join(&dst.path, &it.name);
        let src_path = src_fs.join(&it.location.path, &it.name);
        if let Ok(dst_meta) = dst_fs.metadata(&dst_path).await {
            // 충돌 항목만 src stat 1회 추가(로컬 stat / SFTP 왕복 1회) —
            // 다이얼로그의 새↔기존 크기/수정시각 비교용. 실패해도 plan 유효(None).
            let src_meta = src_fs.metadata(&src_path).await.ok();
            conflicts.push(Conflict {
                name: it.name.clone(),
                dst_path: dst_path.clone(),
                will_become_backup: dst_fs.join(&dst.path, &backup_name(&it.name)),
                dst_is_dir: dst_meta.kind == crate::types::EntryKind::Dir,
                dst_size: dst_meta.size,
                dst_modified_ms: dst_meta.modified_ms,
                src_size: src_meta.as_ref().and_then(|m| m.size),
                src_modified_ms: src_meta.as_ref().and_then(|m| m.modified_ms),
            });
        }
    }

    // 디렉토리는 하위 전체 크기(dir_size: 로컬=재귀 walk, SSH=du -sb)로 합산 →
    // 진행률 분모가 정확해진다. 다만 파일이 아주 많은 트리에선 이 스캔이 곧 "다이얼로그가
    // 안 뜨는 시간"이라, 예산을 넘기면 포기하고 미상(0)으로 넘긴다.
    if measure_total {
        total = tokio::time::timeout(MEASURE_BUDGET, measure_total_bytes(src_fs, &items))
            .await
            .unwrap_or(0);
    }

    let strategy = decide_fs(src_fs, &src_source, dst_fs, &dst.source);
    Ok(CopyPlan {
        src_source,
        dst,
        items,
        conflicts,
        total_size_bytes: total,
        strategy,
    })
}

/// copy/move 항목 중 받는 폴더가 그 항목 자신이거나 하위인 것이 있으면 `IntoItself`.
/// plan 과 execute 진입부 둘 다 부른다 — plan 이후 프론트가 다른 plan 을 보낼 수 있으므로.
async fn ensure_items_not_into_dst(
    src_fs: &dyn FileSystem,
    src_source: &SourceId,
    items: &[EntryRef],
    dst_fs: &dyn FileSystem,
    dst: &Location,
) -> Result<(), DuetError> {
    let paths: Vec<PathBuf> = items
        .iter()
        .map(|it| src_fs.join(&it.location.path, &it.name))
        .collect();
    crate::core::path_guard::ensure_not_into_itself(src_fs, src_source, &paths, dst_fs, dst).await
}

/// Refuse stale/forged host-side plans before any I/O; the caller must plan again.
fn ensure_current_same_host(
    planned: &CopyStrategy,
    src_fs: &dyn FileSystem,
    src: &SourceId,
    dst_fs: &dyn FileSystem,
    dst: &SourceId,
) -> Result<(), DuetError> {
    if planned == &CopyStrategy::SshSameHost
        && decide_fs(src_fs, src, dst_fs, dst) != CopyStrategy::SshSameHost
    {
        return Err(DuetError::Io(
            "same-host plan no longer matches server endpoints; create a new plan".into(),
        ));
    }
    Ok(())
}

/// 항목별 실패들을 **하나의** 에러로 묶는다.
///
/// 예전에는 첫 실패에서 루프를 끊어 뒤 항목을 시도조차 안 했다(1000개 중 3번째가
/// 권한 오류면 997개가 안 갔다). 이제 끝까지 시도하고 여기서 요약한다.
/// 실패 종류가 모두 같으면 그 종류를 유지한다 — 프론트의 승격(UAC/sudo) 재시도가
/// `PermissionDenied` kind 로 분기하기 때문.
fn combine_failures(failures: Vec<(String, DuetError)>) -> DuetError {
    let names: Vec<String> = failures
        .iter()
        .take(5)
        .map(|(name, e)| format!("{name}: {e}"))
        .collect();
    let more = failures.len().saturating_sub(names.len());
    let detail = if more > 0 {
        format!("{} and {more} more", names.join("; "))
    } else {
        names.join("; ")
    };
    let msg = format!("{} item(s) failed — {detail}", failures.len());
    let same_kind = failures
        .windows(2)
        .all(|w| std::mem::discriminant(&w[0].1) == std::mem::discriminant(&w[1].1));
    match failures.into_iter().next() {
        Some((_, first)) if same_kind => match first {
            DuetError::PermissionDenied(_) => DuetError::PermissionDenied(msg),
            DuetError::NotFound(_) => DuetError::NotFound(msg),
            DuetError::Ssh(_) => DuetError::Ssh(msg),
            DuetError::CrossDevice(_) => DuetError::CrossDevice(msg),
            _ => DuetError::Io(msg),
        },
        _ => DuetError::Io(msg),
    }
}

pub async fn copy_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    policy: ConflictPolicy,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    ensure_current_same_host(
        &plan.strategy,
        src_fs,
        &plan.src_source,
        dst_fs,
        &plan.dst.source,
    )?;
    ensure_items_not_into_dst(src_fs, &plan.src_source, &plan.items, dst_fs, &plan.dst).await?;
    match plan.strategy {
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => {
            copy_execute_relay(src_fs, dst_fs, plan, policy, ctx, cancel_token, progress).await
        }
        CopyStrategy::SshSameHost => {
            // same-host rsync: Skip 만 의미있게 반영(--ignore-existing), 그 외는 기존 동작.
            copy_execute_same_host(plan, policy, ctx, cancel_token, progress).await
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
    policy: ConflictPolicy,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    // 누적 바이트 진행률 — plan 전체 크기 대비. chunk 마다 호출되되 ~150ms throttle.
    // plan 이 시간 예산 안에 못 잰 경우(0=미상)엔 여기서 한 번 잰다 — 확인 다이얼로그를
    // 붙잡지 않고, 진행 모달이 뜬 상태에서 분모를 채운다.
    let total = if plan.total_size_bytes > 0 {
        plan.total_size_bytes
    } else {
        // 여기서도 무한정 재지 않는다 — 예산을 넘기면 분모 없이(=진행률 indeterminate,
        // 파일 수/속도는 그대로 표시) 복사를 바로 시작한다.
        tokio::time::timeout(
            EXECUTE_MEASURE_BUDGET,
            measure_total_bytes(src_fs, &plan.items),
        )
        .await
        .unwrap_or(0)
    };
    // done/last 는 항목 시작 emit(emit_item_start)과 공유 — Arc.
    let done = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    // (직전 emit 시각, 직전 emit 바이트) — throttle + 순간속도 계산.
    let last = std::sync::Arc::new(std::sync::Mutex::new((std::time::Instant::now(), 0u64)));
    let files_total = plan.items.len() as u32;
    // 현재 처리 중인 (실제 파일명, top-level 항목 idx) — on_file 이 파일명, 루프가 idx 갱신.
    let cur = std::sync::Arc::new(std::sync::Mutex::new((String::new(), 0u32)));
    let cur_cb = cur.clone();
    let done_cb = done.clone();
    let last_cb = last.clone();
    let progress_cb = progress.clone();
    let on_bytes = move |delta: u64| {
        use std::sync::atomic::Ordering::Relaxed;
        let d = done_cb.fetch_add(delta, Relaxed) + delta;
        let Some(p) = progress_cb.as_ref() else {
            return;
        };
        // total==0(폴더 등 총량 미상) 이면 "완료" 판정을 바이트로 못 하므로 throttle 만.
        let complete = total > 0 && d >= total;
        let speed = if let Ok(mut l) = last_cb.lock() {
            let now = std::time::Instant::now();
            if !complete && now.duration_since(l.0) < PROGRESS_THROTTLE {
                return;
            }
            let s = calc_speed(l.1, l.0, d);
            *l = (now, d);
            s
        } else {
            None
        };
        let (current_file, files_done) = cur_cb
            .lock()
            .map(|g| (Some(g.0.clone()).filter(|s| !s.is_empty()), g.1))
            .unwrap_or((None, 0));
        p.emit(byte_progress(
            d,
            total,
            speed,
            current_file,
            files_done,
            files_total,
        ));
    };
    // 복사 중인 실제 파일명 갱신(폴더 내부 개별 파일까지). copy_tree 가 파일마다 호출.
    let cur_file = cur.clone();
    let file_source = plan.src_source.clone();
    let on_file = move |path: &std::path::Path| {
        if let Ok(mut g) = cur_file.lock() {
            g.0 = file_name_for(&file_source, path)
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
    };

    let mut copied = Vec::new();
    let mut copied_from: Vec<PathBuf> = Vec::new();
    let mut skipped = 0u32;
    // 교체된 **폴더**의 백업 — undo 로 원래 폴더를 되돌리기 위해 journal 에 싣는다.
    let mut kept_backups: Vec<BackupRestore> = Vec::new();
    // 항목별 실패 — 끝까지 시도한 뒤 combine_failures 로 한 번에 보고한다.
    let mut failures: Vec<(String, DuetError)> = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());
    for (idx, it) in plan.items.iter().enumerate() {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        // top-level 항목 idx + 초기 파일명(폴더면 on_file 이 곧 내부 파일로 덮어씀).
        if let Ok(mut g) = cur.lock() {
            *g = (it.name.clone(), idx as u32);
        }
        emit_item_start(
            progress.as_ref(),
            &last,
            &done,
            idx as u32,
            &it.name,
            total,
            files_total,
        );
        // 한 항목 처리 — 내부 ?/return 은 이 async 블록만 빠져나와 아래 outcome 으로 잡힘.
        let step: Result<bool, DuetError> = async {
            let src_path = src_fs.join(&it.location.path, &it.name);
            let mut dst_path = dst_fs.join(&plan.dst.path, &it.name);

            // 충돌 시 policy 분기: Replace=덮어쓰기, Skip=건너뜀, KeepBoth=새이름.
            // Replace 는 기존 대상을 임시 백업으로 옮겨 경로를 비운다(복사 실패 시 롤백용).
            let mut replaced_backup: Option<std::path::PathBuf> = None;
            // 기존 대상이 폴더였나 — 폴더 교체는 병합이 아니라 폴더를 통째로 갈아끼우는
            // 것이라 기존에만 있던 파일까지 사라진다. 파일 덮어쓰기와 달리 되돌릴 수
            // 있어야 하므로(§4 폴더 예외) 성공해도 백업을 지우지 않고 journal 에 남긴다.
            let mut replaced_is_dir = false;
            if let Ok(dst_meta) = dst_fs.metadata(&dst_path).await {
                match policy {
                    ConflictPolicy::Skip => return Ok(true), // skip = 복사 안 함
                    ConflictPolicy::KeepBoth => {
                        dst_path = dedup_dst_name(dst_fs, &plan.dst.path, &it.name).await;
                    }
                    ConflictPolicy::Replace => {
                        replaced_is_dir = dst_meta.kind == crate::types::EntryKind::Dir;
                        let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
                        dst_fs.rename(&dst_path, &backup).await?;
                        replaced_backup = Some(backup);
                    }
                }
            }

            // copy 본체 — chunk 스트리밍(메모리 bounded, mid-file cancel). connection loss 면
            // 1회 retry 하되 resume=true 로 중단된 .part 부터 이어받음(전송 재개).
            let copy_result: Result<(), DuetError> = match crate::fs::copy_relay_streaming(
                src_fs,
                &src_path,
                dst_fs,
                &dst_path,
                false,
                &cancel_token,
                &on_bytes,
                &on_file,
            )
            .await
            {
                Ok(()) => Ok(()),
                Err(e) if crate::services::retry::is_retryable_error(&e) => {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if cancel_token.is_cancelled() {
                        Err(DuetError::Cancelled)
                    } else {
                        crate::fs::copy_relay_streaming(
                            src_fs,
                            &src_path,
                            dst_fs,
                            &dst_path,
                            true, // 재개 — 이미 쓴 .part 이어받기
                            &cancel_token,
                            &on_bytes,
                            &on_file,
                        )
                        .await
                    }
                }
                Err(e) => Err(e),
            };
            // Replace 백업 정리: 파일은 영구 삭제(.bak 안 남김·undo 없음 — §4 예외,
            // 사용자 승인 2026-06), **폴더는 보존 + journal**(§4 폴더 예외 — 폴더 교체는
            // 기존 폴더 전체를 잃는 일이라 되돌릴 수 있어야 한다).
            // 실패면 원위치로 롤백(원본 보존).
            match copy_result {
                Ok(()) => {
                    if let Some(b) = replaced_backup.take() {
                        if replaced_is_dir {
                            kept_backups.push(BackupRestore {
                                backup_path: b,
                                original_path: dst_path.clone(),
                                applied: None, // 그 자리는 copied 지문이 덮는다
                            });
                        } else {
                            // 복사는 이미 성공 — 백업 정리 실패는 치명적이지 않다(가시적
                            // `.bak` 잔여물만 남음). 여기서 `?` 로 실패하면 '완료된 복사'가
                            // 에러로 보고되고 journal 미기록→undo 불가가 되므로, 정리
                            // 실패는 무시하고 성공을 그대로 진행한다.
                            let _ = dst_fs.remove(&b).await;
                        }
                    }
                }
                Err(e) => {
                    if let Some(b) = replaced_backup.take() {
                        // 롤백(백업→원위치) 실패 시 원본이 백업 경로에만 남으므로, 그 위치를
                        // 에러에 실어 사용자가 복구할 수 있게 한다(조용히 삼키지 않음).
                        if let Err(re) = dst_fs.rename(&b, &dst_path).await {
                            return Err(DuetError::Io(format!(
                                "copy failed ({e}); original preserved at backup {} (rollback failed: {re})",
                                b.display()
                            )));
                        }
                    }
                    return Err(e);
                }
            }
            copied.push(dst_path);
            copied_from.push(src_path.clone());
            Ok(false) // false = 실제 복사함(skip 아님)
        }
        .await;
        match step {
            Ok(true) => skipped += 1, // 충돌 skip
            Ok(false) => {}
            // 취소는 즉시 멈춘다. 그 외 실패는 모아 두고 남은 항목을 계속 처리한다
            // — 한 항목의 권한 오류로 나머지 전부를 버리지 않기 위해.
            Err(DuetError::Cancelled) => {
                outcome = Err(DuetError::Cancelled);
                break;
            }
            Err(e) => failures.push((it.name.clone(), e)),
        }
    }
    if outcome.is_ok() && !failures.is_empty() {
        outcome = Err(combine_failures(std::mem::take(&mut failures)));
    }

    // §4: 부분 진행분(복사 완료분)이라도 journal 에 기록한 뒤 에러 전파.
    if copied.is_empty() && kept_backups.is_empty() {
        if outcome.is_err() {
            return Err(outcome.err().unwrap());
        }
        // 전부 skip(충돌 회피)이면 의도된 no-op — 에러 아님(빈 journal 로 통과).
        if skipped == 0 {
            return Err(DuetError::Io("copy affected nothing".into()));
        }
    }
    let count = copied.len() as u32;
    let copied_stamps = crate::core::stamp::stamp_all(dst_fs, &copied).await;
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        // 파일 덮어쓰기는 복원하지 않음(사용자 승인 §4 예외). 폴더 교체만 백업을 남겨
        // undo 로 원래 폴더를 되돌린다(§4 폴더 예외).
        backups_to_restore: kept_backups,
        src_source: Some(plan.src_source.clone()),
        copied_from,
        copied_stamps,
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

/// plan 항목들의 총 바이트 — 진행률 분모. 개별 실패는 0 으로 친다(전체를 못 재는 것보다
/// 낫다). `dir_size` 는 로컬=재귀 walk, SSH=`du -sb`.
pub(crate) async fn measure_total_bytes(src_fs: &dyn FileSystem, items: &[EntryRef]) -> u64 {
    let mut total = 0u64;
    for it in items {
        let src_path = src_fs.join(&it.location.path, &it.name);
        total = total.saturating_add(src_fs.dir_size(&src_path).await.unwrap_or(0));
    }
    total
}

// === Move ===

pub async fn move_plan(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    items: Vec<EntryRef>,
    dst: Location,
) -> Result<MovePlan, DuetError> {
    // same-fs 이동은 rename — 바이트가 흐르지 않아 총량이 진행률 분모로 쓰이지 않는다.
    // 그런데도 미리 스캔하면 대용량 폴더에서 "확인 다이얼로그가 안 뜨는" 무반응 구간만
    // 생기므로 건너뛴다. 같은 SourceId 라도 물리 드라이브가 다르면(C:↔D:) rename 이
    // cross-device 로 거부돼 실제 복사가 되는데, 그땐 move_execute 가 그 시점에 한 번
    // 총량을 잰다(measure_total_bytes) — 진행률·ETA 는 그대로 나온다.
    let src_source = items
        .first()
        .map(|t| t.location.source.clone())
        .ok_or_else(|| DuetError::Io("no items".into()))?;
    let is_same_fs = src_source == dst.source;
    let copy = plan_transfer(src_fs, dst_fs, items, dst.clone(), !is_same_fs).await?;
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
    policy: ConflictPolicy,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    ensure_current_same_host(
        &plan.strategy,
        src_fs,
        &plan.src_source,
        dst_fs,
        &plan.dst.source,
    )?;
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    ensure_items_not_into_dst(src_fs, &plan.src_source, &plan.items, dst_fs, &plan.dst).await?;
    // same-host SSH move: **같은 연결**(= 같은 SourceId, is_same_fs) 이면 SFTP rename
    // 한 번으로 서버 안에서 끝난다 — 원격 서버 정리에서 가장 흔한 작업이라 지원한다.
    // 서로 다른 연결(같은 머신이지만 다른 세션/유저)은 아직 막는다: rename 을 어느 쪽
    // 세션 권한으로 할지가 애매하고, 실패하면 아래 needs_copy 가 relay(이 PC 경유)로
    // 떨어져 "같은 호스트 전송이 이 PC 를 거치는" 금지 폴백이 되기 때문.
    if plan.strategy == CopyStrategy::SshSameHost && !plan.is_same_fs {
        return Err(DuetError::NotSupported(
            "same-host move across two different connections — open both panes on the same connection".into(),
        ));
    }

    // cross-fs 이동(=copy+trash)은 바이트 진행률을 emit — copy 와 동일 메커니즘.
    // (same-fs rename 은 atomic·즉시라 항목 완료마다만 갱신.)
    //
    // same-fs plan 은 총량을 재지 않고 0(=미상)으로 온다. rename 이 cross-device 로
    // 거부돼 실제 복사로 넘어가는 순간에만 아래에서 한 번 재서 채운다 — 그래서 Atomic.
    let total = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(plan.total_size_bytes));
    // 총량을 이미 쟀는지 — cross-device 폴백이 항목마다 반복 측정하지 않게.
    let total_measured = std::sync::atomic::AtomicBool::new(!plan.is_same_fs);
    let total_cb = total.clone();
    // done/last 는 항목 시작 emit(emit_item_start)과 공유 — Arc.
    let done = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let last = std::sync::Arc::new(std::sync::Mutex::new((std::time::Instant::now(), 0u64)));
    let files_total = plan.items.len() as u32;
    let cur = std::sync::Arc::new(std::sync::Mutex::new((String::new(), 0u32)));
    let cur_cb = cur.clone();
    let done_cb = done.clone();
    let last_cb = last.clone();
    let progress_cb = progress.clone();
    let on_bytes = move |delta: u64| {
        use std::sync::atomic::Ordering::Relaxed;
        let d = done_cb.fetch_add(delta, Relaxed) + delta;
        let Some(p) = progress_cb.as_ref() else {
            return;
        };
        let total = total_cb.load(Relaxed);
        let complete = total > 0 && d >= total;
        let speed = if let Ok(mut l) = last_cb.lock() {
            let now = std::time::Instant::now();
            if !complete && now.duration_since(l.0) < PROGRESS_THROTTLE {
                return;
            }
            let s = calc_speed(l.1, l.0, d);
            *l = (now, d);
            s
        } else {
            None
        };
        let (current_file, files_done) = cur_cb
            .lock()
            .map(|g| (Some(g.0.clone()).filter(|s| !s.is_empty()), g.1))
            .unwrap_or((None, 0));
        p.emit(byte_progress(
            d,
            total,
            speed,
            current_file,
            files_done,
            files_total,
        ));
    };
    let cur_file = cur.clone();
    let file_source = plan.src_source.clone();
    let on_file = move |path: &std::path::Path| {
        if let Ok(mut g) = cur_file.lock() {
            g.0 = file_name_for(&file_source, path)
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
        }
    };

    let mut moved = Vec::new();
    let mut skipped = 0u32;
    // 교체된 **폴더**의 백업 — undo 로 원래 폴더를 되돌리기 위해 journal 에 싣는다.
    let mut kept_backups: Vec<BackupRestore> = Vec::new();
    // 항목별 실패 — 끝까지 시도한 뒤 한 번에 보고.
    let mut failures: Vec<(String, DuetError)> = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());
    for (idx, it) in plan.items.iter().enumerate() {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        // 현재 항목명 + 완료 수 — on_bytes 가 emit 에 포함.
        if let Ok(mut g) = cur.lock() {
            *g = (it.name.clone(), idx as u32);
        }
        // same-fs rename 은 바이트가 안 흘러 on_bytes 가 아예 안 불린다 — 이동에서
        // 파일명이 보이는 유일한 경로.
        emit_item_start(
            progress.as_ref(),
            &last,
            &done,
            idx as u32,
            &it.name,
            total.load(std::sync::atomic::Ordering::Relaxed),
            files_total,
        );
        // 한 항목 처리 — 내부 ?/return 은 이 async 블록만 빠져나와 아래 outcome 으로 잡힘.
        let step: Result<bool, DuetError> = async {
            let src_path = src_fs.join(&it.location.path, &it.name);
            let mut dst_path = dst_fs.join(&plan.dst.path, &it.name);

            // 충돌 policy 분기 (copy 와 동일): Replace=덮어쓰기, Skip=건너뜀, KeepBoth=새이름.
            // Replace 는 기존 대상을 임시 백업으로 옮겨 경로를 비운다(이동 실패 시 롤백용).
            let mut replaced_backup: Option<std::path::PathBuf> = None;
            // 폴더 교체는 되돌릴 수 있게 백업 보존(§4 폴더 예외) — copy 와 같은 규칙.
            let mut replaced_is_dir = false;
            if let Ok(dst_meta) = dst_fs.metadata(&dst_path).await {
                match policy {
                    ConflictPolicy::Skip => return Ok(true),
                    ConflictPolicy::KeepBoth => {
                        dst_path = dedup_dst_name(dst_fs, &plan.dst.path, &it.name).await;
                    }
                    ConflictPolicy::Replace => {
                        replaced_is_dir = dst_meta.kind == crate::types::EntryKind::Dir;
                        let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
                        dst_fs.rename(&dst_path, &backup).await?;
                        replaced_backup = Some(backup);
                    }
                }
            }

            let move_result: Result<(), DuetError> = async {
                // same-fs 면 rename(빠르고 atomic). 단 같은 SourceId(둘 다 로컬)라도 물리
                // 드라이브가 다르면(C:↔D: 등) rename 이 cross-device 로 거부되므로, 그땐
                // copy + 휴지통으로 폴백한다 (cross-fs 이동과 동일 처리).
                let needs_copy = if plan.is_same_fs {
                    match src_fs.rename(&src_path, &dst_path).await {
                        Ok(()) => false,
                        Err(DuetError::CrossDevice(_)) => true,
                        Err(e) => return Err(e),
                    }
                } else {
                    true
                };
                // 원격 같은 호스트에서 rename 이 거부되면(서버 안에서 마운트가 다른 경우)
                // 아래 폴백은 이 PC 를 왕복하는 relay 다 — DESIGN "같은 호스트 전송이 이
                // PC 를 거치는 폴백 금지". 조용히 느려지느니 명시적으로 실패시킨다.
                if needs_copy && plan.strategy == CopyStrategy::SshSameHost {
                    return Err(DuetError::NotSupported(
                        "move across filesystems on the remote host — copy, then delete the source"
                            .into(),
                    ));
                }
                if needs_copy {
                    // rename 이 cross-device 로 거부된 경우 = plan 이 건너뛴 총량이 이제
                    // 필요해졌다. 딱 한 번, 남은 전체 항목에 대해 잰다. 확인은 이미 끝났고
                    // 진행 모달이 떠 있는 시점이라 이 지연은 "작업 중"으로 보인다.
                    if !total_measured.swap(true, std::sync::atomic::Ordering::Relaxed) {
                        let sum = measure_total_bytes(src_fs, &plan.items).await;
                        total.store(sum, std::sync::atomic::Ordering::Relaxed);
                    }
                    // copy 본체(스트리밍 — 바이트 진행률 emit) — connection loss 면 1회 retry(재개).
                    match crate::fs::copy_relay_streaming(
                        src_fs,
                        &src_path,
                        dst_fs,
                        &dst_path,
                        false,
                        &cancel_token,
                        &on_bytes,
                        &on_file,
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
                                true,
                                &cancel_token,
                                &on_bytes,
                                &on_file,
                            )
                            .await?;
                        }
                        Err(e) => return Err(e),
                    }
                    // src 는 휴지통으로 (영구삭제 아님)
                    let batch_id = crate::services::trash::new_batch_id();
                    src_fs.trash(&src_path, &batch_id).await?;
                }
                Ok(())
            }
            .await;
            // Replace 백업 정리: 성공이면 영구 삭제(.bak 안 남김·undo 없음 — §4 예외,
            // 사용자 승인 2026-06), 실패면 원위치로 롤백(원본 보존).
            match move_result {
                Ok(()) => {
                    if let Some(b) = replaced_backup.take() {
                        if replaced_is_dir {
                            // 폴더 교체는 백업 보존 + journal → Ctrl+Z 로 원래 폴더 복원.
                            kept_backups.push(BackupRestore {
                                backup_path: b,
                                original_path: dst_path.clone(),
                                applied: None,
                            });
                        } else {
                            // 이동은 이미 성공 — 백업 정리 실패는 치명적이지 않다(가시적
                            // `.bak` 잔여물만). `?` 로 실패하면 '완료된 이동'이 에러로
                            // 보고되고 journal 미기록→undo 불가가 되므로, 정리 실패는
                            // 무시하고 성공을 진행한다.
                            let _ = dst_fs.remove(&b).await;
                        }
                    }
                }
                Err(e) => {
                    if let Some(b) = replaced_backup.take() {
                        // 롤백 실패 시 원본이 백업 경로에만 남으므로 그 위치를 에러에 실어
                        // 사용자가 복구할 수 있게 한다(조용히 삼키지 않음).
                        if let Err(re) = dst_fs.rename(&b, &dst_path).await {
                            return Err(DuetError::Io(format!(
                                "move failed ({e}); original preserved at backup {} (rollback failed: {re})",
                                b.display()
                            )));
                        }
                    }
                    return Err(e);
                }
            }
            moved.push(MoveItem {
                src_original: src_path,
                dst_now: dst_path,
            });
            Ok(false)
        }
        .await;
        match step {
            Ok(true) => skipped += 1, // 충돌 skip
            Ok(false) => {}
            // copy 와 같은 규칙 — 취소만 즉시 멈추고, 나머지 실패는 모아서 계속.
            Err(DuetError::Cancelled) => {
                outcome = Err(DuetError::Cancelled);
                break;
            }
            Err(e) => failures.push((it.name.clone(), e)),
        }
    }
    if outcome.is_ok() && !failures.is_empty() {
        outcome = Err(combine_failures(std::mem::take(&mut failures)));
    }

    // §4: 부분 진행분(이동 완료분)이라도 journal 에 기록한 뒤 에러 전파.
    if moved.is_empty() && kept_backups.is_empty() {
        if outcome.is_err() {
            return Err(outcome.err().unwrap());
        }
        // 전부 skip 이면 의도된 no-op.
        if skipped == 0 {
            return Err(DuetError::Io("move affected nothing".into()));
        }
    }
    let count = moved.len() as u32;
    let undo = UndoAction::UndoMove {
        src_source: plan.src_source.clone(),
        dst_source: plan.dst.source.clone(),
        moved,
        // 파일 덮어쓰기는 복원하지 않음(사용자 승인 §4 예외). 폴더 교체만 백업을 남겨
        // undo 로 원래 폴더를 되돌린다(§4 폴더 예외).
        backups_to_restore: kept_backups,
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
    // 같은 폴더뿐 아니라 상·하위 관계도 거부 — 자기 안으로 무한 복사, 반대 방향 + 삭제
    // 전파면 원본 루트를 휴지통으로 보낸다(SC-03).
    crate::core::path_guard::ensure_roots_unrelated(src_fs, &src, dst_fs, &dst).await?;
    if src_fs.metadata(&src.path).await?.kind != crate::types::EntryKind::Dir
        || dst_fs.metadata(&dst.path).await?.kind != crate::types::EntryKind::Dir
    {
        return Err(DuetError::Io("sync: both sides must be directories".into()));
    }
    let strategy = decide_fs(src_fs, &src.source, dst_fs, &dst.source);
    ensure_sync_supported(&strategy)?;
    Ok(SyncPlan {
        src,
        dst,
        strategy,
        prune: false,
    })
}

/// sync 가 지원하는 조합(local↔local·same-host SSH)만 통과 — 그 밖은 `sync_plan` 과 같은
/// 오류(FE 가 쉬운 문장으로 안내하는 바로 그 문구).
///
/// plan·preview·execute 가 모두 이것을 부른다. raw IPC plan 이 원격 조합을 들고 와도
/// in-Rust 미러(본인 PC 경유 + SshFs 위 mirror/prune)로 새지 않게(sync relay guard).
fn ensure_sync_supported(strategy: &CopyStrategy) -> Result<(), DuetError> {
    if matches!(
        strategy,
        CopyStrategy::LocalToLocal | CopyStrategy::SshSameHost
    ) {
        return Ok(());
    }
    Err(DuetError::NotSupported(
        "sync supports local↔local and same-host SSH only (cross-host relay is a follow-up)".into(),
    ))
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
                total += Box::pin(count_files(fs, &fs.join(dir, &e.name))).await;
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
    ensure_current_same_host(
        &plan.strategy,
        src_fs,
        &plan.src.source,
        dst_fs,
        &plan.dst.source,
    )?;
    // plan 의 strategy 필드를 믿지 않고 지금 소스로 다시 판정한다 — 지원 밖(relay 등)이면
    // sync_plan 과 같은 오류, plan 과 어긋나면(예: 원격인데 LocalToLocal 로 적힘) 새 plan 요구.
    let current = decide_fs(src_fs, &plan.src.source, dst_fs, &plan.dst.source);
    ensure_sync_supported(&current)?;
    if current != plan.strategy {
        return Err(DuetError::Io(
            "sync plan no longer matches the current sources; create a new plan".into(),
        ));
    }
    crate::core::path_guard::ensure_roots_unrelated(src_fs, &plan.src, dst_fs, &plan.dst).await?;
    match plan.strategy {
        CopyStrategy::SshSameHost => {
            sync_execute_same_host(plan, ctx, cancel_token, progress).await
        }
        // LocalToLocal 만 남는다(위 가드) — in-Rust 미러.
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
        created_from: Vec::new(),
        created_dirs: Vec::new(),
        backups: Vec::new(),
        done: 0,
        total,
    };
    // 도중 실패·취소여도 이미 반영한 변경은 journal 에 남긴 뒤 오류를 전파한다(SC-01, §4).
    // 예전엔 `?` 조기 반환이라 복사·덮어쓴 것을 Ctrl+Z 로 되돌릴 수 없었다.
    let mut outcome = mirror_dir(
        src_fs,
        dst_fs,
        &plan.src.path,
        &plan.dst.path,
        &cancel_token,
        progress.as_ref(),
        &mut state,
    )
    .await;
    // prune: src 에 없는 dst 항목을 휴지통으로 (삭제 전파, undo 복원 가능).
    let mut pruned = Vec::new();
    if outcome.is_ok() && plan.prune {
        let batch_id = crate::services::trash::new_batch_id();
        outcome = prune_pass(
            src_fs,
            &plan.src.path,
            dst_fs,
            &plan.dst.path,
            &cancel_token,
            &batch_id,
            &mut pruned,
        )
        .await;
    }
    // 아무것도 바꾸지 못하고 실패·취소했으면 빈 기록을 남기지 않는다(SC-40 과 같은 규칙).
    let changed = !state.created.is_empty()
        || !state.backups.is_empty()
        || !state.created_dirs.is_empty()
        || !pruned.is_empty();
    if !changed {
        if let Err(e) = outcome {
            return Err(e);
        }
    }
    let op = OpKind::Sync {
        count: state.done as u32,
        pruned: pruned.len() as u32,
        src: plan.src.clone(),
        dst: plan.dst.clone(),
    };
    let created_stamps = crate::core::stamp::stamp_all(dst_fs, &state.created).await;
    crate::core::stamp::fill_applied(dst_fs, &mut state.backups).await;
    let undo = UndoAction::UndoSync {
        dst_source: plan.dst.source.clone(),
        created: state.created,
        backups_to_restore: state.backups,
        pruned,
        src_source: Some(plan.src.source.clone()),
        created_from: state.created_from,
        created_stamps,
        created_dirs: state.created_dirs,
    };
    let entry = ctx.journal.push(op, undo).await?;
    outcome?;
    Ok(entry)
}

struct MirrorState {
    created: Vec<PathBuf>,
    /// `created[i]` 의 원본 경로 — redo 용 (병렬 배열).
    created_from: Vec<PathBuf>,
    /// 이 sync 가 새로 만든 폴더(부모 먼저) — undo 가 비었을 때만 제거(SC-31).
    created_dirs: Vec<PathBuf>,
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
    let mut entries = src_fs.list(src_dir).await?;
    // 이름순으로 처리 — 실패·취소 지점이 OS 의 나열 순서에 따라 달라지지 않게.
    entries.sort_by(|a, b| a.name.cmp(&b.name));
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
                    state.created_dirs.push(d.clone());
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
                    mirror_file(
                        src_fs,
                        dst_fs,
                        &s,
                        &d,
                        dst_dir,
                        &e.name,
                        dst_meta.is_some(),
                        state,
                    )
                    .await?;
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
                            ..Default::default()
                        });
                    }
                }
            }
            _ => {} // symlink/other 는 v1 skip.
        }
    }
    Ok(())
}

/// 파일 하나를 미러 — 덮어쓰기면 기존 dst 를 `.bak` 으로 옮긴 뒤 복사한다.
///
/// 복사가 실패하면(SC-01) 원래 이름 자리가 비어 있을 때 백업을 제자리로 되돌린다 —
/// 실패한 동기화가 사용자 파일을 `.bak` 이름으로만 남기지 않게. 자리가 이미 차 있거나
/// (부분 복사) 되돌리기가 실패하면 백업을 기록에 남겨 Ctrl+Z 가 복원하게 한다.
/// 새 파일은 실제로 생긴 경우에만 생성분으로 기록한다.
#[allow(clippy::too_many_arguments)]
async fn mirror_file(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    s: &std::path::Path,
    d: &std::path::Path,
    dst_dir: &std::path::Path,
    name: &str,
    overwrite: bool,
    state: &mut MirrorState,
) -> Result<(), DuetError> {
    let backup = if overwrite {
        let backup = pick_backup_path(dst_fs, dst_dir, name).await?;
        dst_fs.rename(d, &backup).await?;
        Some(backup)
    } else {
        None
    };
    let copied = crate::fs::copy_relay(src_fs, s, dst_fs, d).await;
    let keep_record = match (&copied, &backup) {
        (Ok(()), _) => true,
        (Err(_), Some(b)) => {
            let slot_free = matches!(
                dst_fs.symlink_metadata(d).await,
                Err(DuetError::NotFound(_))
            );
            !(slot_free && dst_fs.rename(b, d).await.is_ok())
        }
        // 새 파일: 확실히 없을 때(NotFound)만 기록에서 뺀다. 확인이 실패하면(권한·연결) 부분
        // 복사본이 남았을 수 있어 보수적으로 기록 — undo 의 지문 검사가 없는 경로는 건너뛴다
        // (`any_exists` 와 같은 규칙).
        (Err(_), None) => !matches!(
            dst_fs.symlink_metadata(d).await,
            Err(DuetError::NotFound(_))
        ),
    };
    if keep_record {
        match backup {
            Some(backup_path) => state.backups.push(BackupRestore {
                backup_path,
                original_path: d.to_path_buf(),
                applied: None, // 기록 직전에 채움
            }),
            None => {
                state.created.push(d.to_path_buf());
                state.created_from.push(s.to_path_buf());
            }
        }
    }
    copied
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
    let backup_dir = crate::fs::posix_join(
        &crate::fs::posix_join(&home, ".duet-trash"),
        &format!("sync-{batch}"),
    );

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
    let mut created_from = Vec::new();
    for line in String::from_utf8_lossy(&dry_out.stdout).lines() {
        if let Some(rel) = parse_rsync_itemize_created_file(line) {
            created.push(crate::fs::posix_join(&plan.dst.path, &rel));
            // same-host rsync — src/dst 모두 POSIX. redo 용 원본 경로.
            created_from.push(crate::fs::posix_join(&plan.src.path, &rel));
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
                            ..Default::default()
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
    let created_stamps = crate::core::stamp::stamp_all(&dst_fs, &created).await;
    crate::core::stamp::fill_applied(&dst_fs, &mut backups).await;
    let undo = UndoAction::UndoSync {
        dst_source: plan.dst.source.clone(),
        created,
        backups_to_restore: backups,
        pruned: vec![],
        src_source: Some(plan.src.source.clone()),
        created_from,
        created_stamps,
        // rsync 가 새로 만든 폴더는 itemize 에서 따로 추리지 않는다(한계 — 빈 폴더가 남을 수 있음).
        created_dirs: vec![],
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
        // 원격(same-host)일 수 있으니 POSIX 결합 — PathBuf::join 의 Windows `\` 회피(§7).
        let p = fs.join(dir, &e.name);
        if e.kind == crate::types::EntryKind::Dir {
            Box::pin(collect_backup_files(fs, &p, backup_root, dst_root, out)).await;
        } else {
            // backup_root prefix 제거한 POSIX 상대경로를 dst_root 아래로 매핑(undo 복원용).
            let p_s = p.to_string_lossy();
            let root_s = backup_root.to_string_lossy();
            if let Some(rel) = p_s.strip_prefix(root_s.as_ref()) {
                let mut original = dst_root.to_path_buf();
                for seg in rel.split('/').filter(|s| !s.is_empty()) {
                    original = crate::fs::posix_join(&original, seg);
                }
                out.push(BackupRestore {
                    backup_path: p.clone(),
                    original_path: original,
                    applied: None, // 기록 직전에 채움
                });
            }
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
        format!("{rel}/{name}") // 표시용 상대경로(실경로는 각 fs.join, 원격 전용은 remote_join; §7)
    }
}

/// 원격(same-host SSH) base 경로에 상대경로 `rel` 을 결합 — 항상 POSIX(`/`).
///
/// `PathBuf::join` 은 Windows 클라이언트에서 `\` 를 끼워넣어 원격 경로를 깨뜨린다(§7).
/// same-host 코드의 모든 `X.path.join(rel)` 은 이걸로 — `rel` 은 `/` 로 구성된 상대 Path.
fn remote_join(base: &std::path::Path, rel: impl AsRef<std::path::Path>) -> PathBuf {
    crate::fs::posix_join(base, &rel.as_ref().to_string_lossy())
}

/// 단방향 미러 dry-run — 복사/prune 목록. local 은 in-Rust 워크(entry_differs
/// 로 실제 sync 와 동일 판정), same-host 는 `rsync -ain --delete` itemize.
/// 지원 밖 조합(relay)은 sync_plan 과 같은 오류(sync relay guard).
pub async fn sync_preview(
    src_fs: &dyn FileSystem,
    src: &Location,
    dst_fs: &dyn FileSystem,
    dst: &Location,
    pool: Option<&Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<SyncPreview, DuetError> {
    let strategy = decide_fs(src_fs, &src.source, dst_fs, &dst.source);
    ensure_sync_supported(&strategy)?;
    crate::core::path_guard::ensure_roots_unrelated(src_fs, src, dst_fs, dst).await?;
    match strategy {
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
        let s = src_fs.join(src_dir, &e.name);
        let d = dst_fs.join(dst_dir, &e.name);
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
        let sp = src_fs.join(src_dir, &e.name);
        let dp = dst_fs.join(dst_dir, &e.name);
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
///
/// 규칙 없이(기본 규칙으로) 비교한다 — 비교창에서 온 머지는 [`merge_bidir_with_rules`] 로
/// 그 창의 규칙을 넘겨야 한다(SC-07).
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
    merge_bidir_with_rules(
        left_fs,
        left,
        right_fs,
        right,
        &crate::core::compare::CompareRules::default(),
        detect_renames_opt,
        ctx,
        cancel_token,
        progress,
    )
    .await
}

/// [`merge_bidir`] + 비교 규칙. 비교창이 무시 패턴으로 숨긴 항목(`node_modules`·`*.log` 등)을
/// 머지가 다시 비교하며 통째로 복사하지 않도록, 그 창이 쓴 규칙 그대로 다시 비교한다(SC-07).
#[allow(clippy::too_many_arguments)]
pub async fn merge_bidir_with_rules(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    rules: &crate::core::compare::CompareRules,
    detect_renames_opt: bool,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    use crate::core::compare::CompareStatus;
    crate::core::path_guard::ensure_roots_unrelated(left_fs, &left, right_fs, &right).await?;
    let mut plan = crate::core::compare::compare_dirs_progress(
        left_fs,
        left.clone(),
        right_fs,
        right.clone(),
        rules,
        &cancel_token,
        &|_| {},
    )
    .await?;
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
    match decide_fs(left_fs, &left.source, right_fs, &right.source) {
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

/// 진행률 emit 최소 간격 — 바이트 진행률과 항목 시작 emit 이 공유한다.
const PROGRESS_THROTTLE: std::time::Duration = std::time::Duration::from_millis(150);

/// 항목 시작 emit 을 내보내도 되는지 판정 + 통과 시 throttle 시각을 선점(갱신).
///
/// 첫 항목(`idx == 0`)은 무조건 통과 — 모달이 뜨자마자 파일명이 보여야 한다.
/// 이후 항목은 바이트 emit 과 같은 `last` 를 공유하므로, 항목이 수천 개여도
/// 이벤트는 150ms 에 한 번으로 묶인다. 순수 함수로 분리해 테스트 가능하게 둠
/// (ProgressEmitter 는 AppHandle 을 들고 있어 유닛 테스트에서 만들 수 없음).
fn claim_item_emit(
    last: &std::sync::Mutex<(std::time::Instant, u64)>,
    idx: u32,
    done: u64,
) -> bool {
    let Ok(mut l) = last.lock() else { return false };
    let now = std::time::Instant::now();
    if idx == 0 || now.duration_since(l.0) >= PROGRESS_THROTTLE {
        *l = (now, done);
        true
    } else {
        false
    }
}

/// 항목 시작 시점의 진행률 emit (copy/move 공용).
///
/// `on_bytes` 는 실제 바이트가 흐른 뒤에야 불리므로 이것 없이는 파일명이 안 보인다:
/// - same-fs 이동은 `rename` 이라 바이트가 0 → `on_bytes` 가 아예 안 불림
/// - 150ms(throttle) 안에 끝나는 짧은 복사도 emit 없이 종료
///
/// 첫 항목은 무조건 emit(모달이 뜨자마자 이름이 보이도록), 이후 항목은 바이트
/// emit 과 같은 throttle 을 공유해 항목이 수천 개일 때 이벤트 폭주를 막는다.
fn emit_item_start(
    progress: Option<&crate::services::task_queue::ProgressEmitter>,
    last: &std::sync::Mutex<(std::time::Instant, u64)>,
    done: &std::sync::atomic::AtomicU64,
    idx: u32,
    name: &str,
    total: u64,
    files_total: u32,
) {
    let Some(p) = progress else { return };
    let d = done.load(std::sync::atomic::Ordering::Relaxed);
    if !claim_item_emit(last, idx, d) {
        return;
    }
    // 속도는 None — 이 시점엔 새 바이트가 흐르지 않아 순간속도를 추정할 근거가 없다.
    p.emit(byte_progress(
        d,
        total,
        None,
        Some(name.to_string()),
        idx,
        files_total,
    ));
}

/// 바이트 진행률 → ProgressInfo (copy/move 공용). `total==0`(폴더 등 총량 미상)이면
/// indeterminate(bytes_total/percent = None) — 프론트가 게이지를 0%로 고정하지 않고
/// "진행 중" 애니메이션 바로 표시하게 한다. total>0 이면 percent + ETA 계산.
#[allow(clippy::too_many_arguments)]
fn byte_progress(
    done: u64,
    total: u64,
    speed_bps: Option<u64>,
    current_file: Option<String>,
    files_done: u32,
    files_total: u32,
) -> crate::services::task_events::ProgressInfo {
    let (bytes_done, bytes_total, percent) = if total > 0 {
        let shown = done.min(total);
        (shown, Some(total), Some((shown * 100 / total) as u8))
    } else {
        (done, None, None)
    };
    // ETA = 남은 바이트 / 속도 (총량·속도 둘 다 있을 때만).
    let eta_sec = match (bytes_total, speed_bps) {
        (Some(t), Some(s)) if s > 0 && t > bytes_done => Some(((t - bytes_done) / s) as u32),
        _ => None,
    };
    crate::services::task_events::ProgressInfo {
        bytes_done,
        bytes_total,
        speed_bps,
        eta_sec,
        percent,
        current_file,
        files_done,
        files_total,
    }
}

/// 순간 속도(bytes/sec) 추정 — 직전 emit 이후의 (Δbytes / Δtime). throttle 간격(~150ms)
/// 기준이라 즉각 반응. 시간차 0 또는 역행이면 None.
fn calc_speed(prev_bytes: u64, prev_at: std::time::Instant, now_bytes: u64) -> Option<u64> {
    let ms = prev_at.elapsed().as_millis();
    if ms == 0 || now_bytes <= prev_bytes {
        return None;
    }
    Some((now_bytes - prev_bytes) * 1000 / ms as u64)
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
            ..Default::default()
        });
    }
}

/// merge 결과를 journal 에 기록 (relay/same-host 공통).
///
/// 생성분 지문은 양쪽 fs 로 잰다(`None` = 그쪽 fs 를 못 얻음 → 지문 없음 = undo 때 건너뜀).
#[allow(clippy::too_many_arguments)]
async fn push_merge_journal(
    ctx: &OpCtx,
    fs: (Option<&dyn FileSystem>, Option<&dyn FileSystem>),
    left: Location,
    right: Location,
    left_created: Vec<PathBuf>,
    right_created: Vec<PathBuf>,
    left_pairs: Vec<RedoCopyPair>,
    right_pairs: Vec<RedoCopyPair>,
) -> Result<JournalEntry, DuetError> {
    let left_created_stamps = stamp_side(fs.0, &left_created).await;
    let right_created_stamps = stamp_side(fs.1, &right_created).await;
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
        left_pairs,
        right_pairs,
        left_created_stamps,
        right_created_stamps,
    };
    ctx.journal.push(op, undo).await
}

/// 한쪽 생성분 지문 — fs 가 없으면 전부 None(확인 불가).
async fn stamp_side(
    fs: Option<&dyn FileSystem>,
    paths: &[PathBuf],
) -> Vec<Option<crate::services::journal::ItemStamp>> {
    match fs {
        Some(fs) => crate::core::stamp::stamp_all(fs, paths).await,
        None => vec![None; paths.len()],
    }
}

/// same-host 기록용 SshFs — 연결을 못 얻으면 None(지문 없이 기록, undo 는 건너뜀).
async fn ssh_fs_opt(
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
    conn: &crate::types::ConnectionId,
) -> Option<crate::fs::SshFs> {
    pool.get(conn).await.ok().map(crate::fs::SshFs::new)
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
    let mut left_pairs: Vec<RedoCopyPair> = Vec::new();
    let mut right_pairs: Vec<RedoCopyPair> = Vec::new();
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
                let s = left_fs.join(
                    &left.path,
                    &crate::core::compare::resolve_side_rel(left_fs, &left.path, rel)
                        .await
                        .to_string_lossy(),
                );
                let d = right_fs.join(
                    &right.path,
                    &crate::core::compare::resolve_side_rel(right_fs, &right.path, rel)
                        .await
                        .to_string_lossy(),
                );
                // 추가 전용 불변식 강제: race 로 dst 가 생겼으면 덮어쓰지 않고 skip.
                if right_fs.metadata(&d).await.is_ok() {
                    tracing::warn!("merge skip (dst exists): {}", d.display());
                    Ok(())
                } else {
                    // 실패해도 부분 산출물 정리를 위해 dst 를 created 에 기록.
                    let r = crate::fs::copy_relay(left_fs, &s, right_fs, &d).await;
                    if r.is_ok() {
                        // redo 용 — 성공 복사만 (partial 정리 항목과 분리).
                        right_pairs.push(RedoCopyPair {
                            from: s,
                            to: d.clone(),
                        });
                    }
                    right_created.push(d);
                    r
                }
            }
            CompareStatus::RightOnly => {
                let s = right_fs.join(
                    &right.path,
                    &crate::core::compare::resolve_side_rel(right_fs, &right.path, rel)
                        .await
                        .to_string_lossy(),
                );
                let d = left_fs.join(
                    &left.path,
                    &crate::core::compare::resolve_side_rel(left_fs, &left.path, rel)
                        .await
                        .to_string_lossy(),
                );
                if left_fs.metadata(&d).await.is_ok() {
                    tracing::warn!("merge skip (dst exists): {}", d.display());
                    Ok(())
                } else {
                    let r = crate::fs::copy_relay(right_fs, &s, left_fs, &d).await;
                    if r.is_ok() {
                        left_pairs.push(RedoCopyPair {
                            from: s,
                            to: d.clone(),
                        });
                    }
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
    // SC-40: 아무것도 만들지 않고 실패·취소했으면 빈 기록을 남기지 않는다(Ctrl+Z 를 소모하지 않게).
    // 생성 예정으로 적어 둔 경로는 실제로 생겼는지 확인한다(첫 복사가 시작 전에 실패한 경우).
    if !any_exists(Some(left_fs), &left_created).await
        && !any_exists(Some(right_fs), &right_created).await
    {
        if let Err(e) = outcome {
            return Err(e);
        }
    }
    let entry = push_merge_journal(
        ctx,
        (Some(left_fs), Some(right_fs)),
        left,
        right,
        left_created,
        right_created,
        left_pairs,
        right_pairs,
    )
    .await?;
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
    let mut left_pairs: Vec<RedoCopyPair> = Vec::new();
    let mut right_pairs: Vec<RedoCopyPair> = Vec::new();
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
                let s = remote_join(&left.path, rel);
                let d = remote_join(&right.path, rel);
                match host_side_copy_one(pool, left_conn, &s, &d).await {
                    Ok(true) => {
                        right_pairs.push(RedoCopyPair {
                            from: s,
                            to: d.clone(),
                        });
                        right_created.push(d);
                        Ok(())
                    }
                    Ok(false) => {
                        tracing::warn!("merge skip (dst exists): {}", d.display());
                        Ok(())
                    }
                    Err(e) => {
                        right_created.push(d); // partial 트리 정리용 (redo 쌍엔 제외)
                        Err(e)
                    }
                }
            }
            CompareStatus::RightOnly => {
                let s = remote_join(&right.path, rel);
                let d = remote_join(&left.path, rel);
                match host_side_copy_one(pool, right_conn, &s, &d).await {
                    Ok(true) => {
                        left_pairs.push(RedoCopyPair {
                            from: s,
                            to: d.clone(),
                        });
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
    let left_fs = ssh_fs_opt(pool, left_conn).await;
    let right_fs = ssh_fs_opt(pool, right_conn).await;
    // SC-40: 아무것도 만들지 않고 실패·취소했으면 빈 기록을 남기지 않는다.
    if !any_exists(
        left_fs.as_ref().map(|f| f as &dyn FileSystem),
        &left_created,
    )
    .await
        && !any_exists(
            right_fs.as_ref().map(|f| f as &dyn FileSystem),
            &right_created,
        )
        .await
    {
        if let Err(e) = outcome {
            return Err(e);
        }
    }
    let entry = push_merge_journal(
        ctx,
        (
            left_fs.as_ref().map(|f| f as &dyn FileSystem),
            right_fs.as_ref().map(|f| f as &dyn FileSystem),
        ),
        left,
        right,
        left_created,
        right_created,
        left_pairs,
        right_pairs,
    )
    .await?;
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
        let dst_parent =
            posix_path::parent(dst).ok_or_else(|| DuetError::Io("dst has no parent".into()))?;
        let dst_parent_arg = shell_escape_path(&dst_parent)?;
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
    /// redo 용 성공 복사 쌍 (신규 생성만 — 덮어쓰기/실패 행 제외).
    left_pairs: Vec<RedoCopyPair>,
    right_pairs: Vec<RedoCopyPair>,
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
    crate::core::path_guard::ensure_roots_unrelated(left_fs, &left, right_fs, &right).await?;
    let work: Vec<(ApplyDirection, String)> = decisions
        .into_iter()
        .filter(|d| !matches!(d.direction, ApplyDirection::Skip))
        .map(|d| (d.direction, d.rel))
        .collect();
    match decide_fs(left_fs, &left.source, right_fs, &right.source) {
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
///
/// 생성분·덮어쓴 자리의 지문은 양쪽 fs 로 잰다(`None` = 그쪽 fs 를 못 얻음 → 지문 없음).
async fn push_compare_apply_journal(
    ctx: &OpCtx,
    fs: (Option<&dyn FileSystem>, Option<&dyn FileSystem>),
    left: Location,
    right: Location,
    mut st: ApplyState,
) -> Result<JournalEntry, DuetError> {
    let (left_created_stamps, right_created_stamps) = stamp_apply_state(fs, &mut st).await;
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
        left_pairs: st.left_pairs,
        right_pairs: st.right_pairs,
        left_created_stamps,
        right_created_stamps,
    };
    ctx.journal.push(op, undo).await
}

/// `ApplyState` 의 덮어쓴 자리(`applied`)를 채우고 생성분 지문(왼쪽, 오른쪽)을 돌려준다.
async fn stamp_apply_state(
    fs: (Option<&dyn FileSystem>, Option<&dyn FileSystem>),
    st: &mut ApplyState,
) -> (
    Vec<Option<crate::services::journal::ItemStamp>>,
    Vec<Option<crate::services::journal::ItemStamp>>,
) {
    if let Some(f) = fs.0 {
        crate::core::stamp::fill_applied(f, &mut st.left_backups).await;
    }
    if let Some(f) = fs.1 {
        crate::core::stamp::fill_applied(f, &mut st.right_backups).await;
    }
    (
        stamp_side(fs.0, &st.left_created).await,
        stamp_side(fs.1, &st.right_created).await,
    )
}

/// 실제로 무언가 바뀐 적용인가(SC-40 — 실패·취소면 빈 기록을 남기지 않음). 백업이 있으면
/// 바뀐 것이고, 생성 예정 경로는 실제로 생겼는지 본다.
async fn apply_state_changed(
    fs: (Option<&dyn FileSystem>, Option<&dyn FileSystem>),
    st: &ApplyState,
) -> bool {
    !st.left_backups.is_empty()
        || !st.right_backups.is_empty()
        || any_exists(fs.0, &st.left_created).await
        || any_exists(fs.1, &st.right_created).await
}

/// 생성 예정으로 적어 둔 경로 중 실제로 생긴 것이 있나(SC-40). 확인할 fs 가 없거나 확인이
/// 실패하면 true — 부분 결과를 잃지 않도록 보수적으로 기록 쪽.
async fn any_exists(fs: Option<&dyn FileSystem>, paths: &[PathBuf]) -> bool {
    let Some(fs) = fs else {
        return !paths.is_empty();
    };
    for p in paths {
        match fs.symlink_metadata(p).await {
            Err(DuetError::NotFound(_)) => {}
            _ => return true,
        }
    }
    false
}

/// 한 행 적용 결과. 비교 뒤 원본이 사라진 행은 받는 쪽을 건드리지 않고 건너뛴다(SC-08).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RowApplied {
    Done,
    SourceMissing,
}

/// 원본이 그새 사라져 건너뛴 행들을 한 오류로 보고한다(앞 몇 개 이름만).
fn missing_sources_error(missing: &[String]) -> DuetError {
    const SHOWN: usize = 5;
    let mut names = missing
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if missing.len() > SHOWN {
        names.push_str(&format!(" (+{} more)", missing.len() - SHOWN));
    }
    DuetError::NotFound(format!(
        "source no longer exists — skipped {} item(s), destination left as is: {names}",
        missing.len()
    ))
}

/// 원본이 있는지 먼저 본다 — 없으면(NotFound) `SourceMissing`, 다른 오류는 그대로 전파.
async fn source_present(fs: &dyn FileSystem, src: &std::path::Path) -> Result<bool, DuetError> {
    match fs.metadata(src).await {
        Ok(_) => Ok(true),
        Err(DuetError::NotFound(_)) => Ok(false),
        Err(e) => Err(e),
    }
}

/// 한 행을 relay 로 적용 — 원본 확인 후, dst 존재면 백업 후 복사, 아니면 생성 기록 후 복사.
#[allow(clippy::too_many_arguments)]
async fn apply_one_relay(
    direction: &ApplyDirection,
    rel: &std::path::Path,
    left_fs: &dyn FileSystem,
    left: &Location,
    right_fs: &dyn FileSystem,
    right: &Location,
    st: &mut ApplyState,
) -> Result<RowApplied, DuetError> {
    let (src_fs, src_path, dst_fs, dst_path, dst_is_left) = match direction {
        ApplyDirection::ToRight => (
            left_fs,
            left_fs.join(
                &left.path,
                &crate::core::compare::resolve_side_rel(left_fs, &left.path, rel)
                    .await
                    .to_string_lossy(),
            ),
            right_fs,
            right_fs.join(
                &right.path,
                &crate::core::compare::resolve_side_rel(right_fs, &right.path, rel)
                    .await
                    .to_string_lossy(),
            ),
            false,
        ),
        ApplyDirection::ToLeft => (
            right_fs,
            right_fs.join(
                &right.path,
                &crate::core::compare::resolve_side_rel(right_fs, &right.path, rel)
                    .await
                    .to_string_lossy(),
            ),
            left_fs,
            left_fs.join(
                &left.path,
                &crate::core::compare::resolve_side_rel(left_fs, &left.path, rel)
                    .await
                    .to_string_lossy(),
            ),
            true,
        ),
        ApplyDirection::Skip => return Ok(RowApplied::Done),
    };
    // 원본부터 확인 — 비교 뒤 원본이 사라졌으면 받는 쪽을 `.bak` 으로 치우기 전에
    // 건너뛴다(SC-08). 예전엔 백업 rename 후 복사가 NotFound 로 실패해 원래 이름이 비었다.
    if !source_present(src_fs, &src_path).await? {
        return Ok(RowApplied::SourceMissing);
    }
    let mut created = false;
    if dst_fs.metadata(&dst_path).await.is_ok() {
        let dst_source = if dst_is_left {
            &left.source
        } else {
            &right.source
        };
        let parent = parent_for(dst_source, &dst_path)
            .ok_or_else(|| DuetError::Io("dst has no parent".into()))?;
        let name = file_name_for(dst_source, &dst_path)
            .and_then(|s| s.to_str())
            .ok_or_else(|| DuetError::Io("dst has no name".into()))?;
        let backup = pick_backup_path(dst_fs, &parent, name).await?;
        dst_fs.rename(&dst_path, &backup).await?;
        let br = BackupRestore {
            backup_path: backup,
            original_path: dst_path.clone(),
            applied: None, // 기록 직전에 채움
        };
        if dst_is_left {
            st.left_backups.push(br);
        } else {
            st.right_backups.push(br);
        }
    } else if dst_is_left {
        st.left_created.push(dst_path.clone());
        created = true;
    } else {
        st.right_created.push(dst_path.clone());
        created = true;
    }
    let res = crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await;
    if res.is_ok() && created {
        // redo 용 — 성공한 신규 생성만 (덮어쓰기 행은 백업 복원과 얽혀 제외).
        let pair = RedoCopyPair {
            from: src_path.clone(),
            to: dst_path.clone(),
        };
        if dst_is_left {
            st.left_pairs.push(pair);
        } else {
            st.right_pairs.push(pair);
        }
    }
    res.map(|()| RowApplied::Done)
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
    let mut missing: Vec<String> = Vec::new();
    for (direction, rel) in &work {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let rel_path = std::path::Path::new(rel);
        match apply_one_relay(
            direction, rel_path, left_fs, &left, right_fs, &right, &mut st,
        )
        .await
        {
            Ok(RowApplied::Done) => {}
            Ok(RowApplied::SourceMissing) => missing.push(rel.clone()),
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    if outcome.is_ok() && !missing.is_empty() {
        outcome = Err(missing_sources_error(&missing));
    }
    if !apply_state_changed((Some(left_fs), Some(right_fs)), &st).await {
        if let Err(e) = outcome {
            return Err(e);
        }
    }
    let entry =
        push_compare_apply_journal(ctx, (Some(left_fs), Some(right_fs)), left, right, st).await?;
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
    let mut missing: Vec<String> = Vec::new();
    for (direction, rel) in &work {
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let rel_path = std::path::Path::new(rel);
        match apply_one_same_host(
            direction, rel_path, &left, left_conn, &right, right_conn, pool, &mut st,
        )
        .await
        {
            Ok(RowApplied::Done) => {}
            Ok(RowApplied::SourceMissing) => missing.push(rel.clone()),
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    if outcome.is_ok() && !missing.is_empty() {
        outcome = Err(missing_sources_error(&missing));
    }
    let left_fs = ssh_fs_opt(pool, left_conn).await;
    let right_fs = ssh_fs_opt(pool, right_conn).await;
    let fs = (
        left_fs.as_ref().map(|f| f as &dyn FileSystem),
        right_fs.as_ref().map(|f| f as &dyn FileSystem),
    );
    if !apply_state_changed(fs, &st).await {
        if let Err(e) = outcome {
            return Err(e);
        }
    }
    let entry = push_compare_apply_journal(ctx, fs, left, right, st).await?;
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
) -> Result<RowApplied, DuetError> {
    let (src_path, src_conn, dst_path, dst_conn, dst_is_left) = match direction {
        ApplyDirection::ToRight => (
            remote_join(&left.path, rel),
            left_conn,
            remote_join(&right.path, rel),
            right_conn,
            false,
        ),
        ApplyDirection::ToLeft => (
            remote_join(&right.path, rel),
            right_conn,
            remote_join(&left.path, rel),
            left_conn,
            true,
        ),
        ApplyDirection::Skip => return Ok(RowApplied::Done),
    };
    // 원본부터 확인(SC-08) — 없으면 받는 쪽을 백업으로 치우지 않고 건너뛴다.
    let src_fs = crate::fs::SshFs::new(pool.get(src_conn).await?);
    if !source_present(&src_fs, &src_path).await? {
        return Ok(RowApplied::SourceMissing);
    }
    // dst 존재면 SFTP rename 으로 백업 → dst 부재화(이후 host_side_copy_one 이 복사).
    let dst_fs = crate::fs::SshFs::new(pool.get(dst_conn).await?);
    let mut created = false;
    if dst_fs.metadata(&dst_path).await.is_ok() {
        let parent = posix_path::parent(&dst_path)
            .ok_or_else(|| DuetError::Io("dst has no parent".into()))?;
        let name = posix_path::file_name(&dst_path)
            .ok_or_else(|| DuetError::Io("dst has no name".into()))?;
        let backup = pick_backup_path(&dst_fs, &parent, name).await?;
        dst_fs.rename(&dst_path, &backup).await?;
        let br = BackupRestore {
            backup_path: backup,
            original_path: dst_path.clone(),
            applied: None, // 기록 직전에 채움
        };
        if dst_is_left {
            st.left_backups.push(br);
        } else {
            st.right_backups.push(br);
        }
    } else if dst_is_left {
        st.left_created.push(dst_path.clone());
        created = true;
    } else {
        st.right_created.push(dst_path.clone());
        created = true;
    }
    // dst 부재 보장됨 → host_side_copy_one 은 실제 복사(Ok(true)) 후 반환.
    host_side_copy_one(pool, src_conn, &src_path, &dst_path).await?;
    if created {
        let pair = RedoCopyPair {
            from: src_path.clone(),
            to: dst_path.clone(),
        };
        if dst_is_left {
            st.left_pairs.push(pair);
        } else {
            st.right_pairs.push(pair);
        }
    }
    Ok(RowApplied::Done)
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
    let p = fs.join(
        &root.path,
        &crate::core::compare::resolve_side_rel(fs, &root.path, rel)
            .await
            .to_string_lossy(),
    );
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
    // left↔right 는 서로 복사·휴지통을 주고받고, base 는 둘의 기준이다 — 어느 쌍이든
    // 상·하위면 비교 목록에 상대 루트가 섞여 자기 안으로 복사하거나 루트를 휴지통으로 보낸다.
    for (a_fs, a, b_fs, b) in [
        (left_fs, &left, right_fs, &right),
        (base_fs, &base, left_fs, &left),
        (base_fs, &base, right_fs, &right),
    ] {
        crate::core::path_guard::ensure_roots_unrelated(a_fs, a, b_fs, b).await?;
    }
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
        decide_fs(left_fs, &left.source, right_fs, &right.source),
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
    let mut missing: Vec<String> = Vec::new();

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
            S::LeftDeleted => trash_rel(right_fs, &right, rel, &batch, &mut trashed_right)
                .await
                .map(|()| RowApplied::Done),
            S::RightDeleted => trash_rel(left_fs, &left, rel, &batch, &mut trashed_left)
                .await
                .map(|()| RowApplied::Done),
            _ => Ok(RowApplied::Done),
        };
        match res {
            Ok(RowApplied::Done) => {}
            // 비교 뒤 원본이 사라짐 — 받는 쪽 그대로, 적용 수에서 제외(SC-08).
            Ok(RowApplied::SourceMissing) => {
                missing.push(entry.rel.clone());
                continue;
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
        done += 1;
        emit_merge_progress(&progress, done, total);
    }
    if outcome.is_ok() && !missing.is_empty() {
        outcome = Err(missing_sources_error(&missing));
    }

    // SC-40: 아무것도 바꾸지 않고 실패·취소했으면 빈 기록을 남기지 않는다.
    if !apply_state_changed((Some(left_fs), Some(right_fs)), &st).await
        && trashed_left.is_empty()
        && trashed_right.is_empty()
    {
        if let Err(e) = outcome {
            return Err(e);
        }
    }
    let (left_created_stamps, right_created_stamps) =
        stamp_apply_state((Some(left_fs), Some(right_fs)), &mut st).await;
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
        left_created_stamps,
        right_created_stamps,
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
    match decide_fs(left_fs, &left.source, right_fs, &right.source) {
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
        let lp = left_fs.join(
            &left.path,
            &crate::core::compare::resolve_side_rel(left_fs, &left.path, rel_path)
                .await
                .to_string_lossy(),
        );
        let rp = right_fs.join(
            &right.path,
            &crate::core::compare::resolve_side_rel(right_fs, &right.path, rel_path)
                .await
                .to_string_lossy(),
        );
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

/// Build the hash command used by same-host verify and rename signatures.
fn same_host_hash_command(paths: &[PathBuf]) -> Result<String, DuetError> {
    let inputs = paths
        .iter()
        .map(|path| crate::core::copy_strategy::shell_escape_path(path))
        .collect::<Result<Vec<_>, _>>()?;
    if inputs.is_empty() {
        return Ok(":".into());
    }
    let sequence = |tool: &str| {
        inputs
            .iter()
            .map(|input| format!("LC_ALL=C {tool} < {input}"))
            .collect::<Vec<_>>()
            .join(" && ")
    };
    let gnu = sequence("sha256sum");
    let bsd = sequence("shasum -a 256");
    Ok(format!(
        "if command -v sha256sum >/dev/null 2>&1; then {gnu}; else {bsd}; fi"
    ))
}

/// host-side sha256(없으면 shasum -a 256)으로 양쪽 해시 비교 — PC 다운로드 0.
async fn verify_same_host(
    left: &Location,
    right: &Location,
    rels: Vec<String>,
    pool: &Arc<crate::services::connection_pool::ConnectionPool>,
) -> Result<Vec<VerifyResult>, DuetError> {
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
        // Two stdin digests in one exec, in left/right order.
        let cmd = same_host_hash_command(&[
            remote_join(&left.path, rel_path),
            remote_join(&right.path, rel_path),
        ])?;
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

    let strategy = decide_fs(left_fs, &plan.left.source, right_fs, &plan.right.source);
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
                let rel_path = crate::core::compare::resolve_side_rel(
                    fs,
                    &root.path,
                    std::path::Path::new(rel),
                )
                .await;
                match fs
                    .read_full(&fs.join(&root.path, &rel_path.to_string_lossy()))
                    .await
                {
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
    use crate::ssh::remote_exec::exec;
    let SourceId::Ssh { connection_id, .. } = &root.source else {
        return Err(DuetError::Io("same-host rename on non-ssh".into()));
    };
    let conn = pool.get(connection_id).await?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    // Keep candidate order for the digest-to-relative-path mapping.
    let paths: Vec<PathBuf> = cands
        .iter()
        .map(|(rel, _)| remote_join(&root.path, rel))
        .collect();
    let cmd = same_host_hash_command(&paths)?;
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
    // FS 별 이름 규칙(빈 이름, `.`/`..`, `/`·`\`, Windows 예약 이름 등) — `\` 를 거르지 않으면
    // Windows 에서 `..\x` 가 폴더 밖으로 옮기는 경로가 된다(fileops-19).
    fs.validate_new_name(&new_name)?;
    let from = fs.join(&target.location.path, &target.name);
    let to = fs.join(&target.location.path, &new_name);
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
        let collision = if new == old {
            false // no-op (기존 이름은 이 FS 규칙에 안 맞아도 건드리지 않으니 통과)
        } else if fs.validate_new_name(new).is_err() {
            // 경로 구분자·`..`·예약 이름 — 미리보기에서 막고 실행도 거부(fileops-19).
            true
        } else if dup_in_batch || overlaps_selected_old {
            true
        } else {
            fs.metadata(&fs.join(&location.path, new)).await.is_ok() // 선택 밖 기존 파일
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
            froms.push(fs.join(&location.path, old));
            tos.push(fs.join(&location.path, new));
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
    fs.validate_new_name(&name)?;
    let path = fs.join(&parent.path, &name);
    // Friendly duplicate-name errors; mkdir itself remains the final atomic guard.
    ensure_entry_absent(fs, &path, &name).await?;
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

/// 권한(chmod) 변경 — 비재귀는 항목별 이전 mode 를 기록해 undo 가능. 재귀는 하위
/// 전체의 이전 mode 기록이 비현실적이라 Irreversible(§4 예외 — FE 가 경고를 표시하고
/// 사용자가 재귀를 명시 선택한 경우에만 호출).
pub async fn set_permissions(
    fs: &dyn FileSystem,
    targets: Vec<EntryRef>,
    mode: u32,
    recursive: bool,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    let first = targets
        .first()
        .ok_or_else(|| DuetError::Io("no targets".into()))?;
    let source = first.location.source.clone();
    let location = first.location.clone();
    let mode = mode & 0o7777;

    let mut items = Vec::with_capacity(targets.len());
    for t in &targets {
        let path = fs.join(&t.location.path, &t.name);
        // 적용 전 mode 캡처(비재귀 undo 용). permissions 미상(None)이면 undo 에서 제외.
        let old = fs.metadata(&path).await?.permissions;
        fs.set_mode(&path, mode, recursive).await?;
        if let Some(old_mode) = old {
            items.push(ChmodItem { path, old_mode });
        }
    }

    let undo = if recursive || items.is_empty() {
        UndoAction::Irreversible
    } else {
        UndoAction::UndoChmod {
            source: source.clone(),
            items,
        }
    };
    ctx.journal
        .push(
            OpKind::Chmod {
                count: targets.len() as u32,
                mode,
                recursive,
                location,
            },
            undo,
        )
        .await
}

/// owner/group 이름 검증 — 영숫자 + `._-`, 선두 `-` 금지(명령 옵션 오인 방지).
/// (경로/spec 은 셸 quoting 되지만 chown 자체가 인자로 파싱하므로 별도 방어.)
fn valid_owner_name(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// 소유자/그룹(chown) 변경 — 원격 전용(로컬은 fs 가 NotSupported). 이전 소유자
/// 미기록이라 Irreversible — FE 가 경고 표시 후 호출.
pub async fn set_owner(
    fs: &dyn FileSystem,
    targets: Vec<EntryRef>,
    owner: Option<String>,
    group: Option<String>,
    recursive: bool,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    let first = targets
        .first()
        .ok_or_else(|| DuetError::Io("no targets".into()))?;
    let location = first.location.clone();
    let owner = owner.filter(|s| !s.is_empty());
    let group = group.filter(|s| !s.is_empty());
    for name in owner.iter().chain(group.iter()) {
        if !valid_owner_name(name) {
            return Err(DuetError::Io(format!("invalid owner/group name: {name}")));
        }
    }
    if owner.is_none() && group.is_none() {
        return Err(DuetError::Io("owner or group required".into()));
    }
    let spec = match (&owner, &group) {
        (Some(o), Some(g)) => format!("{o}:{g}"),
        (Some(o), None) => o.clone(),
        (None, Some(g)) => format!(":{g}"),
        (None, None) => unreachable!(),
    };

    for t in &targets {
        let path = fs.join(&t.location.path, &t.name);
        fs.set_owner(&path, owner.as_deref(), group.as_deref(), recursive)
            .await?;
    }
    ctx.journal
        .push(
            OpKind::Chown {
                count: targets.len() as u32,
                spec,
                recursive,
                location,
            },
            UndoAction::Irreversible,
        )
        .await
}

/// 심볼릭 링크 생성 — undo 는 링크 자체 제거(대상 불변).
pub async fn make_symlink(
    fs: &dyn FileSystem,
    parent: Location,
    name: String,
    target: String,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Err(DuetError::Io(format!("invalid link name: {name}")));
    }
    if target.is_empty() {
        return Err(DuetError::Io("symlink target required".into()));
    }
    let path = fs.join(&parent.path, &name);
    // 자리에 뭔가 있으면 명시 에러 (ln -s 도 실패하지만 메시지 통일).
    if fs.symlink_metadata(&path).await.is_ok() {
        return Err(DuetError::Io(format!("already exists: {name}")));
    }
    fs.make_symlink(&path, &target).await?;
    ctx.journal
        .push(
            OpKind::Symlink {
                path: path.clone(),
                source: parent.source.clone(),
            },
            UndoAction::UndoSymlink {
                source: parent.source,
                path,
            },
        )
        .await
}

/// 빈 파일 생성 — undo 는 (여전히 비어 있을 때만) 파일 제거.
///
/// 존재 확인은 오류 안내용이다. 최종 생성은 exclusive open으로 경쟁 상황에서도
/// 기존 파일·심볼릭 링크를 덮어쓰지 않는다.
pub async fn create_file(
    fs: &dyn FileSystem,
    parent: Location,
    name: String,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    fs.validate_new_name(&name)?;
    let path = fs.join(&parent.path, &name);
    // symlink_metadata — 깨진 심볼릭 링크가 있는 자리도 "이미 있음"으로 본다.
    ensure_entry_absent(fs, &path, &name).await?;
    fs.create_new_file(&path).await?;
    ctx.journal
        .push(
            OpKind::NewFile {
                path: path.clone(),
                source: parent.source.clone(),
            },
            UndoAction::UndoNewFile {
                source: parent.source,
                path,
            },
        )
        .await
}

async fn ensure_entry_absent(
    fs: &dyn FileSystem,
    path: &std::path::Path,
    name: &str,
) -> Result<(), DuetError> {
    match fs.symlink_metadata(path).await {
        Ok(_) => Err(DuetError::Io(format!("already exists: {name}"))),
        Err(DuetError::NotFound(_)) => Ok(()),
        Err(e) => Err(e),
    }
}

// === Helpers ===

/// backup 이름 선택 — 같은 timestamp 충돌 시 .<n> suffix retry.
pub(crate) async fn pick_backup_path(
    fs: &dyn FileSystem,
    parent: &std::path::Path,
    original_name: &str,
) -> Result<PathBuf, DuetError> {
    let base = backup_name(original_name);
    // fs 의 구분자 규칙으로 결합(원격=POSIX) — parent.join 은 Windows 클라이언트에서 원격
    // 백업 경로에 `\` 를 섞어 SFTP rename 이 깨진다(§7). apply/archive/copy 백업 공통 chokepoint.
    let mut candidate = fs.join(parent, &base);
    if fs.metadata(&candidate).await.is_err() {
        return Ok(candidate);
    }
    for n in 2..=6 {
        candidate = fs.join(parent, &crate::fs::suffixed_name(&base, &format!(".{n}")));
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
    policy: ConflictPolicy,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    use crate::core::copy_progress::{parse_rsync_out_format_name, parse_rsync_progress2_line};
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
    let mut copied_from: Vec<PathBuf> = Vec::new();
    let mut outcome: Result<(), DuetError> = Ok(());

    /// 충돌 항목을 정책대로 미리 해석한 결과 — 아래 복사 루프가 그대로 따른다.
    enum Resolved {
        /// 충돌 없음 — dst 부모에 basename 으로 그대로.
        Plain,
        /// Skip — 이 항목은 아예 복사하지 않는다.
        Skip,
        /// KeepBoth — 비어 있는 새 이름으로 복사(둘 다 유지).
        NewName(PathBuf),
        /// Replace — 기존을 .bak 으로 비운 뒤 제자리에 복사.
        Replaced,
    }

    // Replace 로 비워 둔 백업 — 성공 시 파일은 영구 삭제(§4 예외), 폴더는 journal 로
    // 남겨 undo 가능하게(§4 폴더 예외). 실패 시엔 종류와 무관하게 journal(복원용).
    let mut pending_backups: Vec<(BackupRestore, bool)> = Vec::new();

    // 정책 해석(+Replace backup). 예전에는 정책과 무관하게 충돌 대상을 전부 .bak 으로
    // 옮긴 뒤 rsync `--ignore-existing`/`cp -n` 을 걸어서, **Skip 을 골라도 경로가 비어
    // 있으니 그냥 복사**되고 .bak 만 남았다(KeepBoth 도 덮어쓰기로 폴백). relay 경로와
    // 같은 의미가 되도록 여기서 항목별로 결정한다.
    let mut resolved: Vec<Resolved> = Vec::with_capacity(plan.items.len());
    let mut skipped = 0u32;
    for it in &plan.items {
        // 항목 경계 cancel check (정책 해석 pre-loop)
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let step: Result<Resolved, DuetError> = async {
            let dst_path = crate::fs::posix_join(&plan.dst.path, &it.name);
            let Ok(dst_meta) = dst_fs.metadata(&dst_path).await else {
                return Ok(Resolved::Plain);
            };
            match policy {
                ConflictPolicy::Skip => Ok(Resolved::Skip),
                ConflictPolicy::KeepBoth => Ok(Resolved::NewName(
                    dedup_dst_name(&dst_fs, &plan.dst.path, &it.name).await,
                )),
                ConflictPolicy::Replace => {
                    let is_dir = dst_meta.kind == crate::types::EntryKind::Dir;
                    let backup = pick_backup_path(&dst_fs, &plan.dst.path, &it.name).await?;
                    dst_fs.rename(&dst_path, &backup).await?;
                    pending_backups.push((
                        BackupRestore {
                            backup_path: backup,
                            original_path: dst_path,
                            applied: None, // 기록 직전에 채움(아래)
                        },
                        is_dir,
                    ));
                    Ok(Resolved::Replaced)
                }
            }
        }
        .await;
        match step {
            Ok(r) => {
                if matches!(r, Resolved::Skip) {
                    skipped += 1;
                }
                resolved.push(r);
            }
            Err(e) => {
                outcome = Err(e);
                break;
            }
        }
    }

    for (it, res) in plan.items.iter().zip(resolved.iter()) {
        // 해석 루프가 중간 실패했으면 copy 진행 안 함 (부분 backup 상태로 복사 금지).
        if outcome.is_err() {
            break;
        }
        // Skip 으로 결정된 항목은 건드리지 않는다(기존 파일 보존).
        if matches!(res, Resolved::Skip) {
            continue;
        }
        // 항목 경계 cancel check (copy main loop)
        if cancel_token.is_cancelled() {
            outcome = Err(DuetError::Cancelled);
            break;
        }
        let step: Result<(), DuetError> = async {
            let src_path = crate::fs::posix_join(&it.location.path, &it.name);
            let dst_path = match res {
                Resolved::NewName(p) => p.clone(),
                _ => crate::fs::posix_join(&plan.dst.path, &it.name),
            };
            let src_arg = shell_escape_path(&src_path)?;

            let cmd = if use_rsync {
                // rsync 는 SRC(trailing-slash 없음) 를 DEST *디렉토리* 안에 basename
                // 으로 생성한다. 따라서 dst.path.join(name) (= 최종 경로) 을 주면
                // dir 복사 시 한 단계 더 중첩됨 (dst/many/many/). 부모 디렉토리
                // (plan.dst.path) 를 줘야 dst/<name> 으로 떨어진다 — file/dir 동일.
                //
                // KeepBoth 만 예외: 최종 이름이 basename 과 다르므로 **없는 경로**인
                // 최종 경로를 준다 — rsync 는 DEST 가 없으면 그 이름으로 만든다.
                let dest_arg = match res {
                    Resolved::NewName(p) => shell_escape_path(p)?,
                    _ => shell_escape_path(&plan.dst.path)?,
                };
                // --out-format=DUETF:%n 로 전송 파일명을 한 줄씩 찍게 해 현재 파일명 표시.
                // (progress2 의 집계 라인과 구분되도록 DUETF: 접두 sentinel.)
                format!("rsync -a --info=progress2 --out-format=DUETF:%n -- {src_arg} {dest_arg}")
            } else {
                // cp 는 DEST 를 새 이름으로 취급 → 최종 경로를 그대로 준다.
                // (Skip 은 위에서 항목째 제외, KeepBoth 는 dst_path 가 이미 새 이름.)
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
            let mut current_file: Option<String> = None;
            let exec_result = {
                let handle = session_mutex.lock().await;
                exec_streaming(&handle, &cmd, |line| {
                    // 파일명 라인(DUETF:<relpath>) — 현재 전송 중인 파일명 갱신(디렉토리 제외).
                    if let Some(name) = parse_rsync_out_format_name(line) {
                        current_file = Some(name);
                        return;
                    }
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
                                    current_file: current_file.clone(),
                                    ..Default::default()
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
            copied_from.push(src_path.clone());
            Ok(())
        }
        .await;
        if let Err(e) = step {
            outcome = Err(e);
            break;
        }
    }

    // Replace 백업 정리 — 성공했을 때만 파일 백업을 영구 삭제한다(§4 예외, .bak 안 남김).
    // 폴더 백업은 남겨 journal 에 싣는다(§4 폴더 예외 — 폴더 교체는 되돌릴 수 있어야).
    // 실패했으면 종류와 무관하게 전부 journal 로 보내 undo 가 복원할 수 있게 한다.
    for (b, is_dir) in pending_backups {
        if outcome.is_ok() && !is_dir {
            let _ = dst_fs.remove(&b.backup_path).await;
        } else {
            backups.push(b);
        }
    }

    // §4 (A4): 충돌 backup + 부분 복사분이라도 journal 에 기록한 뒤 에러 전파 —
    // backup 후 copy 실패 시 .bak 고아 + undo 미기록(Ctrl+Z 복원 불가) 버그 수정.
    if copied.is_empty() && backups.is_empty() {
        if outcome.is_err() {
            return Err(outcome.err().unwrap());
        }
        // 전부 skip(충돌 회피)이면 의도된 no-op — 에러 아님(relay 경로와 동일).
        if skipped == 0 {
            return Err(DuetError::Io("copy affected nothing".into()));
        }
    }
    let count = copied.len() as u32;
    let copied_stamps = crate::core::stamp::stamp_all(&dst_fs, &copied).await;
    crate::core::stamp::fill_applied_uncovered(&dst_fs, &mut backups, &copied).await;
    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
        src_source: Some(plan.src_source.clone()),
        copied_from,
        copied_stamps,
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
    async fn creation_uses_filesystem_join_for_both_files_and_directories() {
        let dir = TempDir::new().unwrap();
        let mut fs = crate::fs::testing::TestFs::new(dir.path());
        fs.override_join = true;
        let parent = Location {
            source: SourceId::Local,
            path: "/must-use-filesystem-join".into(),
        };
        let (ctx, _keep) = mk_ctx().await;
        mkdir(&fs, parent.clone(), "folder".into(), &ctx)
            .await
            .unwrap();
        create_file(&fs, parent, "file".into(), &ctx).await.unwrap();
        assert!(dir.path().join("folder").is_dir());
        assert!(dir.path().join("file").is_file());
    }

    /// chmod — 비재귀는 UndoChmod(이전 mode 기록), 재귀는 Irreversible.
    #[cfg(unix)]
    #[tokio::test]
    async fn set_permissions_journals_old_modes_nonrecursive_only() {
        use std::os::unix::fs::PermissionsExt;
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("a.txt");
        tokio::fs::write(&f, b"x").await.unwrap();
        tokio::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o644))
            .await
            .unwrap();
        let fs = LocalFs::new();

        let entry = set_permissions(
            &fs,
            vec![mk_target(dir.path(), "a.txt")],
            0o600,
            false,
            &ctx,
        )
        .await
        .unwrap();
        assert_eq!(
            tokio::fs::metadata(&f).await.unwrap().permissions().mode() & 0o777,
            0o600
        );
        match &entry.undo {
            UndoAction::UndoChmod { items, .. } => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].old_mode & 0o777, 0o644);
            }
            other => panic!("expected UndoChmod, got {other:?}"),
        }

        // 재귀 → Irreversible.
        let sub = dir.path().join("d");
        tokio::fs::create_dir(&sub).await.unwrap();
        let entry2 = set_permissions(&fs, vec![mk_target(dir.path(), "d")], 0o755, true, &ctx)
            .await
            .unwrap();
        assert!(matches!(entry2.undo, UndoAction::Irreversible));
    }

    /// 심볼릭 링크 — 생성 + UndoSymlink 기록, 기존 이름 충돌 거부.
    #[cfg(unix)]
    #[tokio::test]
    async fn make_symlink_journals_undo_and_rejects_existing() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("t.txt"), b"x")
            .await
            .unwrap();
        let fs = LocalFs::new();
        let parent = Location {
            source: SourceId::Local,
            path: dir.path().to_path_buf(),
        };
        let entry = make_symlink(&fs, parent.clone(), "l".into(), "t.txt".into(), &ctx)
            .await
            .unwrap();
        assert!(matches!(entry.undo, UndoAction::UndoSymlink { .. }));
        let m = tokio::fs::symlink_metadata(dir.path().join("l"))
            .await
            .unwrap();
        assert!(m.file_type().is_symlink());
        // 같은 이름 재생성 → 명시 에러.
        assert!(make_symlink(&fs, parent, "l".into(), "t.txt".into(), &ctx)
            .await
            .is_err());
    }

    /// 새 파일 — 빈 파일 생성 + UndoNewFile 기록, 기존 이름은 덮어쓰지 않고 거부.
    #[tokio::test]
    async fn create_file_journals_undo_and_rejects_existing() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        let fs = LocalFs::new();
        let parent = Location {
            source: SourceId::Local,
            path: dir.path().to_path_buf(),
        };
        let entry = create_file(&fs, parent.clone(), "note.txt".into(), &ctx)
            .await
            .unwrap();
        assert!(matches!(entry.undo, UndoAction::UndoNewFile { .. }));
        let created = dir.path().join("note.txt");
        assert!(created.is_file());
        assert_eq!(tokio::fs::read(&created).await.unwrap().len(), 0);

        // 기존 파일 이름으로 재생성 → 에러 (내용 보존, truncate 금지).
        tokio::fs::write(dir.path().join("keep.txt"), b"data")
            .await
            .unwrap();
        assert!(create_file(&fs, parent.clone(), "keep.txt".into(), &ctx)
            .await
            .is_err());
        assert_eq!(
            tokio::fs::read(dir.path().join("keep.txt")).await.unwrap(),
            b"data"
        );
        // 경로 구분자가 섞인 이름은 거부 (§7 — 하위 경로 생성 방지).
        assert!(create_file(&fs, parent, "a/b.txt".into(), &ctx)
            .await
            .is_err());
    }

    /// 사용자 시나리오 재현: 이름이 아주 긴 항목을 복사 — 충돌(Replace: 임시백업 rename)
    /// 까지 포함해 끝까지 간다. 예전엔 `.duet-part`(+10)·`.bak.<ts>`(+20) 가 파일명
    /// 한계를 넘겨 "File name too long" 으로 통째로 실패했다(탐색은 멀쩡한데 복사만 안 됨).
    #[tokio::test]
    async fn copy_long_named_item_over_existing_succeeds() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(&src).await.unwrap();
        tokio::fs::create_dir_all(&dst).await.unwrap();
        let long = "가".repeat(80) + ".txt"; // 84자 / 244바이트 — OS 한계 바로 아래
        tokio::fs::write(src.join(&long), b"NEW").await.unwrap();
        tokio::fs::write(dst.join(&long), b"OLD").await.unwrap();

        let local = LocalFs::new();
        let items = vec![EntryRef {
            location: Location {
                source: SourceId::Local,
                path: src.clone(),
            },
            name: long.clone(),
        }];
        let dst_loc = Location {
            source: SourceId::Local,
            path: dst.clone(),
        };
        let plan = copy_plan(&local, &local, items, dst_loc).await.unwrap();
        assert_eq!(plan.conflicts.len(), 1, "덮어쓰기 충돌이 잡혀야 한다");
        let (ctx, _keep) = mk_ctx().await;
        copy_execute(
            &local,
            &local,
            plan,
            ConflictPolicy::Replace,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(dst.join(&long)).await.unwrap(), b"NEW");
    }

    /// 긴 이름의 백업/유니크 이름도 파일명 한계(255) 안에 들어와야 한다 —
    /// 안 그러면 충돌 시 rename 이 실패해 복사/이동 전체가 무산된다.
    #[tokio::test]
    async fn long_names_stay_within_component_limit() {
        let long = "n".repeat(250) + ".txt";
        assert!(backup_name(&long).len() <= crate::fs::MAX_COMPONENT);

        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join(&long), b"x")
            .await
            .unwrap();
        let local = LocalFs::new();
        let unique = dedup_dst_name(&local, dir.path(), &long).await;
        let name = unique.file_name().unwrap().to_string_lossy();
        assert!(name.len() <= crate::fs::MAX_COMPONENT, "len={}", name.len());
        assert_ne!(name, long, "충돌 회피 이름은 원본과 달라야 한다");
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
        let result = delete_execute(&local, plan, &ctx, "delete", None).await;
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
        let bad = delete_execute(&local, mk_plan().await, &ctx, "wrong", None).await;
        assert!(matches!(bad, Err(DuetError::NotPermitted)));
        assert!(dir.path().join("a").exists());

        // 올바른 단어 → 삭제.
        let ok = delete_execute(&local, mk_plan().await, &ctx, "delete", None).await;
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
        let result = delete_execute(&fs, plan, &ctx, "", None).await;
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

    /// 충돌 시 (src/a, dst/a 둘 다 존재) 정책별 동작 — 로컬 relay(맥에서 검증 가능).
    /// guard(TempDir 들)를 함께 반환해 테스트 종료 전 파일이 삭제되지 않게 한다.
    async fn run_conflict_copy(
        policy: ConflictPolicy,
    ) -> (std::path::PathBuf, TempDir, OpCtx, TempDir) {
        use crate::core::copy_strategy::CopyStrategy;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(&src).await.unwrap();
        tokio::fs::create_dir_all(&dst).await.unwrap();
        tokio::fs::write(src.join("a"), b"NEW").await.unwrap();
        tokio::fs::write(dst.join("a"), b"OLD").await.unwrap(); // 충돌

        let items = vec![EntryRef {
            location: Location {
                source: SourceId::Local,
                path: src.clone(),
            },
            name: "a".into(),
        }];
        let plan = CopyPlan {
            src_source: SourceId::Local,
            dst: Location {
                source: SourceId::Local,
                path: dst.clone(),
            },
            items,
            conflicts: vec![],
            total_size_bytes: 3,
            strategy: CopyStrategy::LocalToLocal,
        };
        let (ctx, ctx_dir) = mk_ctx().await;
        let local = LocalFs::new();
        copy_execute(
            &local,
            &local,
            plan,
            policy,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        (dst, dir, ctx, ctx_dir)
    }

    #[tokio::test]
    async fn conflict_replace_overwrites_without_bak() {
        let (dst, _dir, _ctx, _cd) = run_conflict_copy(ConflictPolicy::Replace).await;
        // dst/a 는 새 내용으로 영구 덮어쓰기 — .bak 백업을 남기지 않는다(undo 없음, §4 예외).
        assert_eq!(tokio::fs::read(dst.join("a")).await.unwrap(), b"NEW");
        let mut rd = tokio::fs::read_dir(&dst).await.unwrap();
        let mut count = 0;
        let mut has_bak = false;
        while let Some(e) = rd.next_entry().await.unwrap() {
            count += 1;
            if e.file_name().to_string_lossy().contains(".bak.") {
                has_bak = true;
            }
        }
        assert!(
            !has_bak,
            "Replace 는 .bak 을 남기지 않아야 함(영구 덮어쓰기)"
        );
        assert_eq!(count, 1, "dst 에는 덮어쓴 항목 1개만 남아야 함");
    }

    #[tokio::test]
    async fn move_conflict_replace_overwrites_without_bak() {
        use crate::core::copy_strategy::CopyStrategy;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(&src).await.unwrap();
        tokio::fs::create_dir_all(&dst).await.unwrap();
        tokio::fs::write(src.join("a"), b"NEW").await.unwrap();
        tokio::fs::write(dst.join("a"), b"OLD").await.unwrap(); // 충돌

        let items = vec![EntryRef {
            location: Location {
                source: SourceId::Local,
                path: src.clone(),
            },
            name: "a".into(),
        }];
        let plan = MovePlan {
            src_source: SourceId::Local,
            dst: Location {
                source: SourceId::Local,
                path: dst.clone(),
            },
            items,
            conflicts: vec![],
            is_same_fs: true,
            total_size_bytes: 3,
            strategy: CopyStrategy::LocalToLocal,
        };
        let (ctx, _cd) = mk_ctx().await;
        let local = LocalFs::new();
        move_execute(
            &local,
            &local,
            plan,
            ConflictPolicy::Replace,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        // dst/a 영구 덮어쓰기, src/a 는 사라짐(이동), .bak 없음.
        assert_eq!(tokio::fs::read(dst.join("a")).await.unwrap(), b"NEW");
        assert!(!src.join("a").exists(), "이동이므로 src 에서 사라져야 함");
        let mut rd = tokio::fs::read_dir(&dst).await.unwrap();
        let mut count = 0;
        let mut has_bak = false;
        while let Some(e) = rd.next_entry().await.unwrap() {
            count += 1;
            if e.file_name().to_string_lossy().contains(".bak.") {
                has_bak = true;
            }
        }
        assert!(!has_bak, "move Replace 도 .bak 을 남기지 않아야 함");
        assert_eq!(count, 1, "dst 에는 덮어쓴 항목 1개만 남아야 함");
    }

    /// 한 항목이 실패해도 나머지는 계속 복사돼야 한다.
    /// 예전에는 첫 실패에서 루프를 끊어, 1000개 중 3번째가 실패하면 997개가 안 갔다.
    #[tokio::test]
    async fn copy_continues_after_one_item_fails() {
        use crate::core::copy_strategy::CopyStrategy;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(&src).await.unwrap();
        tokio::fs::create_dir_all(&dst).await.unwrap();
        tokio::fs::write(src.join("a.txt"), b"A").await.unwrap();
        tokio::fs::write(src.join("c.txt"), b"C").await.unwrap();
        // b 는 plan 에만 있고 실제로는 없는 항목 — 복사 시 실패한다.
        let items = ["a.txt", "b-missing.txt", "c.txt"]
            .into_iter()
            .map(|n| mk_target(&src, n))
            .collect::<Vec<_>>();
        let plan = CopyPlan {
            src_source: SourceId::Local,
            dst: Location {
                source: SourceId::Local,
                path: dst.clone(),
            },
            items,
            conflicts: vec![],
            total_size_bytes: 2,
            strategy: CopyStrategy::LocalToLocal,
        };
        let (ctx, _cd) = mk_ctx().await;
        let local = LocalFs::new();
        let err = copy_execute(
            &local,
            &local,
            plan,
            ConflictPolicy::Skip,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .expect_err("실패 항목이 있으므로 에러로 보고돼야 함");

        // 실패는 요약해 보고하되, 나머지 두 개는 실제로 복사돼 있어야 한다.
        assert!(
            err.to_string().contains("b-missing.txt"),
            "실패한 이름이 메시지에 있어야 함: {err}"
        );
        assert_eq!(tokio::fs::read(dst.join("a.txt")).await.unwrap(), b"A");
        assert_eq!(
            tokio::fs::read(dst.join("c.txt")).await.unwrap(),
            b"C",
            "실패 항목 뒤의 항목도 복사돼야 함"
        );
    }

    /// 폴더를 폴더 위에 Replace — 파일과 달리 되돌릴 수 있어야 한다(§4 폴더 예외).
    /// 폴더 교체는 병합이 아니라 통째 교체라, 기존에만 있던 파일이 영구히 사라지면 안 된다.
    #[tokio::test]
    async fn copy_dir_conflict_replace_keeps_recoverable_backup() {
        use crate::core::copy_strategy::CopyStrategy;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(src.join("d")).await.unwrap();
        tokio::fs::create_dir_all(dst.join("d")).await.unwrap();
        tokio::fs::write(src.join("d/new.txt"), b"NEW")
            .await
            .unwrap();
        // 기존 폴더에만 있는 파일 — 교체로 사라지지만 undo 로 돌아와야 한다.
        tokio::fs::write(dst.join("d/only-old.txt"), b"OLD")
            .await
            .unwrap();

        let items = vec![EntryRef {
            location: Location {
                source: SourceId::Local,
                path: src.clone(),
            },
            name: "d".into(),
        }];
        let plan = CopyPlan {
            src_source: SourceId::Local,
            dst: Location {
                source: SourceId::Local,
                path: dst.clone(),
            },
            items,
            conflicts: vec![],
            total_size_bytes: 3,
            strategy: CopyStrategy::LocalToLocal,
        };
        let (ctx, _cd) = mk_ctx().await;
        let local = LocalFs::new();
        let entry = copy_execute(
            &local,
            &local,
            plan,
            ConflictPolicy::Replace,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        // 새 폴더가 자리를 차지하고, 기존 폴더는 .bak 으로 남아 있다.
        assert_eq!(
            tokio::fs::read(dst.join("d/new.txt")).await.unwrap(),
            b"NEW"
        );
        assert!(
            !dst.join("d/only-old.txt").exists(),
            "폴더 교체이므로 기존 폴더의 파일은 새 폴더에 없다"
        );
        let UndoAction::UndoCopy {
            backups_to_restore, ..
        } = &entry.undo
        else {
            panic!("UndoCopy 여야 함");
        };
        assert_eq!(
            backups_to_restore.len(),
            1,
            "폴더 교체는 백업을 journal 에 남겨 undo 가능해야 함"
        );
        assert!(
            backups_to_restore[0].backup_path.exists(),
            "백업 폴더가 실제로 남아 있어야 함"
        );
    }

    #[tokio::test]
    async fn conflict_skip_leaves_existing() {
        let (dst, _dir, _ctx, _cd) = run_conflict_copy(ConflictPolicy::Skip).await;
        // 건너뜀 — 기존 내용 그대로, 새 파일 안 들어옴, .bak 없음.
        assert_eq!(tokio::fs::read(dst.join("a")).await.unwrap(), b"OLD");
        let mut rd = tokio::fs::read_dir(&dst).await.unwrap();
        let mut count = 0;
        while let Some(_e) = rd.next_entry().await.unwrap() {
            count += 1;
        }
        assert_eq!(count, 1, "skip 이면 dst 에 항목이 1개(기존)만");
    }

    #[tokio::test]
    async fn conflict_keep_both_creates_new_name() {
        let (dst, _dir, _ctx, _cd) = run_conflict_copy(ConflictPolicy::KeepBoth).await;
        // 둘 다 유지 — 기존 a + 새 "a (1)".
        assert_eq!(tokio::fs::read(dst.join("a")).await.unwrap(), b"OLD");
        assert_eq!(tokio::fs::read(dst.join("a (1)")).await.unwrap(), b"NEW");
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
            ConflictPolicy::Replace,
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
            ConflictPolicy::Replace,
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
        // 새↔기존 비교 메타: dst("existing"=8B)/src("new"=3B) 크기 + 수정시각.
        assert_eq!(plan.conflicts[0].dst_size, Some(8));
        assert_eq!(plan.conflicts[0].src_size, Some(3));
        assert!(plan.conflicts[0].dst_modified_ms.is_some());
        assert!(plan.conflicts[0].src_modified_ms.is_some());
    }

    /// same-fs 이동 plan 은 총량 스캔(dir_size)을 건너뛴다 — rename 이라 분모로 쓰이지
    /// 않는데 대용량 폴더에서 확인 다이얼로그를 몇 초씩 붙잡던 비용. 충돌 탐지는 그대로.
    #[tokio::test]
    async fn move_plan_same_fs_skips_size_scan_but_keeps_conflicts() {
        let dir = TempDir::new().unwrap();
        tokio::fs::create_dir_all(dir.path().join("d/sub"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("d/sub/big"), vec![0u8; 4096])
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.path().join("dst/d"))
            .await
            .unwrap();

        let local = LocalFs::new();
        let item = mk_target(dir.path(), "d");
        let dst = Location {
            source: SourceId::Local,
            path: dir.path().join("dst"),
        };

        let mv = move_plan(&local, &local, vec![item.clone()], dst.clone())
            .await
            .unwrap();
        assert!(mv.is_same_fs);
        // 총량 미상(0) — 스캔을 안 했다는 뜻. 진행률은 indeterminate 로 표시된다.
        assert_eq!(mv.total_size_bytes, 0);
        // 그래도 충돌은 잡는다 (dst/d 가 이미 있음).
        assert_eq!(mv.conflicts.len(), 1);
        assert_eq!(mv.conflicts[0].name, "d");

        // 복사는 총량이 진행률 분모라 그대로 잰다.
        let cp = copy_plan(&local, &local, vec![item], dst).await.unwrap();
        assert_eq!(cp.total_size_bytes, 4096);
    }

    /// 지연 측정 헬퍼 — cross-device 폴백에서 분모를 채우는 데 쓴다.
    #[tokio::test]
    async fn measure_total_bytes_sums_items() {
        let dir = TempDir::new().unwrap();
        tokio::fs::create_dir(dir.path().join("d")).await.unwrap();
        tokio::fs::write(dir.path().join("d/x"), vec![0u8; 300])
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("f"), vec![0u8; 12])
            .await
            .unwrap();
        let local = LocalFs::new();
        let items = vec![mk_target(dir.path(), "d"), mk_target(dir.path(), "f")];
        assert_eq!(measure_total_bytes(&local, &items).await, 312);
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
        // 휴지통은 임시 폴더 fixture (OS 휴지통 금지).
        let outcome = crate::core::undo::undo_with_fixture(&entry).await;
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
        assert!(matches!(r, Err(DuetError::IntoItself(_))));
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
        let outcome = crate::core::undo::undo_with_fixture(&entry).await;
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

    /// 첫 항목은 throttle 을 무시하고 통과 — 모달이 뜨자마자 파일명이 보여야 한다.
    /// (same-fs 이동은 rename 이라 바이트가 안 흘러 on_bytes 가 아예 안 불린다.)
    #[test]
    fn claim_item_emit_always_passes_first_item() {
        let last = std::sync::Mutex::new((std::time::Instant::now(), 0u64));
        assert!(claim_item_emit(&last, 0, 0));
    }

    /// 이후 항목은 150ms throttle 공유 — 항목 수천 개에서 이벤트 폭주 방지.
    #[test]
    fn claim_item_emit_throttles_later_items() {
        let last = std::sync::Mutex::new((std::time::Instant::now(), 0u64));
        assert!(!claim_item_emit(&last, 1, 10), "직후 재emit 은 막혀야 함");
        assert!(!claim_item_emit(&last, 7, 20));
    }

    /// throttle 이 지나면 다시 통과하고, 통과 시 (시각, 바이트) 를 선점 갱신한다.
    #[test]
    fn claim_item_emit_passes_after_throttle_and_updates() {
        let past =
            std::time::Instant::now() - PROGRESS_THROTTLE - std::time::Duration::from_millis(10);
        let last = std::sync::Mutex::new((past, 0u64));
        assert!(claim_item_emit(&last, 3, 4096));
        // 선점됐으므로 바로 뒤이은 같은 항목 emit 은 막힌다.
        assert!(!claim_item_emit(&last, 3, 4096));
        assert_eq!(last.lock().unwrap().1, 4096, "직전 emit 바이트 갱신");
    }

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
        let outcome = crate::core::undo::undo_with_fixture(&entry).await;
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
    #[tokio::test]
    async fn delete_cancellation_stops_between_items_and_journals_completed_items() {
        let dir = TempDir::new().unwrap();
        for name in ["a", "b"] {
            tokio::fs::write(dir.path().join(name), b"keep")
                .await
                .unwrap();
        }
        let cancel = tokio_util::sync::CancellationToken::new();
        let mut fs = crate::fs::testing::TestFs::new(dir.path());
        fs.cancel_after_trash = Some(cancel.clone());
        let targets = vec![mk_target(dir.path(), "a"), mk_target(dir.path(), "b")];
        let plan = delete_plan(&fs, targets, DeleteMode::Trash).await.unwrap();
        let (ctx, _keep) = mk_ctx().await;
        let result = delete_execute_cancellable(&fs, plan, &ctx, "", None, &cancel).await;
        assert!(matches!(result, Err(DuetError::Cancelled)));
        assert!(!dir.path().join("a").exists());
        assert_eq!(
            tokio::fs::read(dir.path().join("b")).await.unwrap(),
            b"keep"
        );
        let history = ctx.journal.history(10).await;
        assert_eq!(history.len(), 1);
        match &history[0].undo {
            UndoAction::RestoreFromTrash { items, .. } => assert_eq!(items.len(), 1),
            other => panic!("expected partial trash journal, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn mkdir_rejects_path_names_and_preserves_existing_directory() {
        let dir = TempDir::new().unwrap();
        let parent = Location {
            source: SourceId::Local,
            path: dir.path().to_path_buf(),
        };
        let (ctx, _keep) = mk_ctx().await;
        for name in [".", "..", "../outside", "..\\outside"] {
            assert!(mkdir(&LocalFs, parent.clone(), name.into(), &ctx)
                .await
                .is_err());
        }
        mkdir(&LocalFs, parent.clone(), "검증 폴더".into(), &ctx)
            .await
            .unwrap();
        assert!(mkdir(&LocalFs, parent, "검증 폴더".into(), &ctx)
            .await
            .is_err());
        assert!(dir.path().join("검증 폴더").is_dir());
    }
}

#[cfg(test)]
mod review_fileops_sol {
    use super::*;
    use crate::fs::LocalFs;
    use crate::types::{Entry, EntryKind, EntryMeta};
    use std::io::Write;
    use std::path::Path;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll};
    use tokio::io::{AsyncRead, AsyncWrite};
    use tokio_util::sync::CancellationToken;

    fn loc(p: &Path) -> Location {
        Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        }
    }
    fn target(p: &Path, name: &str) -> EntryRef {
        EntryRef {
            location: loc(p),
            name: name.into(),
        }
    }
    async fn ctx(p: &Path) -> OpCtx {
        OpCtx {
            journal: Journal::load_from(&p.join("review-journal.jsonl"))
                .await
                .unwrap(),
            settings: SettingsStore::load_from(&p.join("review-settings.toml"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        }
    }
    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let s = t.path().join("src");
        let d = t.path().join("dst");
        std::fs::create_dir(&s).unwrap();
        std::fs::create_dir(&d).unwrap();
        (t, s, d)
    }
    #[allow(clippy::too_many_arguments)]
    async fn cp(
        sf: &dyn FileSystem,
        df: &dyn FileSystem,
        s: &Path,
        name: &str,
        d: &Path,
        policy: ConflictPolicy,
        c: &OpCtx,
        cancel: CancellationToken,
    ) -> Result<JournalEntry, DuetError> {
        let plan = copy_plan(sf, df, vec![target(s, name)], loc(d)).await?;
        copy_execute(sf, df, plan, policy, c, cancel, None).await
    }
    async fn mv(
        sf: &dyn FileSystem,
        df: &dyn FileSystem,
        s: &Path,
        name: &str,
        d: &Path,
        c: &OpCtx,
    ) -> Result<JournalEntry, DuetError> {
        let plan = move_plan(sf, df, vec![target(s, name)], loc(d)).await?;
        move_execute(
            sf,
            df,
            plan,
            ConflictPolicy::Replace,
            c,
            CancellationToken::new(),
            None,
        )
        .await
    }

    /// All mutations remain in a TempDir. Native copying sees real paths; trash never uses OS APIs.
    struct FaultFs {
        root: PathBuf,
        cross_from: Option<PathBuf>,
        fail_trash: bool,
        stream: bool,
        write_limit: Option<usize>,
        cancel_on_write: Option<CancellationToken>,
        cancel_only: Option<PathBuf>,
        fail_list_at: Option<PathBuf>,
        fail_renames: Vec<usize>,
        renames: AtomicUsize,
    }
    impl FaultFs {
        fn new(root: &Path) -> Self {
            Self {
                root: root.into(),
                cross_from: None,
                fail_trash: false,
                stream: false,
                write_limit: None,
                cancel_on_write: None,
                cancel_only: None,
                fail_list_at: None,
                fail_renames: vec![],
                renames: AtomicUsize::new(0),
            }
        }
    }
    struct Writer {
        file: std::fs::File,
        left: Option<usize>,
        cancel: Option<CancellationToken>,
    }
    impl AsyncWrite for Writer {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
            bytes: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            let len = self.left.unwrap_or(bytes.len()).min(bytes.len());
            if len == 0 {
                return Poll::Ready(Err(std::io::Error::from_raw_os_error(28)));
            }
            let result = self.file.write(&bytes[..len]);
            if let Ok(n) = result {
                if let Some(left) = self.left.as_mut() {
                    *left -= n;
                }
                if let Some(cancel) = &self.cancel {
                    cancel.cancel();
                }
            }
            Poll::Ready(result)
        }
        fn poll_flush(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(self.file.flush())
        }
        fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            self.poll_flush(cx)
        }
    }
    #[async_trait::async_trait]
    impl FileSystem for FaultFs {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        fn validate_new_name(&self, name: &str) -> Result<(), DuetError> {
            LocalFs.validate_new_name(name)
        }
        async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
            if self.fail_list_at.as_deref() == Some(path) {
                return Err(DuetError::PermissionDenied("injected list failure".into()));
            }
            let mut entries = LocalFs.list(path).await?;
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            Ok(entries)
        }
        async fn metadata(&self, path: &Path) -> Result<EntryMeta, DuetError> {
            let mut m = LocalFs.metadata(path).await?;
            if self.stream && m.kind == EntryKind::File {
                m.size = Some(65 * 1024 * 1024);
            }
            Ok(m)
        }
        async fn dir_size(&self, path: &Path) -> Result<u64, DuetError> {
            LocalFs.dir_size(path).await
        }
        async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
            let n = self.renames.fetch_add(1, Ordering::SeqCst) + 1;
            if self
                .cross_from
                .as_ref()
                .is_some_and(|s| from.starts_with(s))
            {
                return Err(DuetError::CrossDevice("injected volume boundary".into()));
            }
            if self.fail_renames.contains(&n) {
                return Err(DuetError::PermissionDenied(format!("injected rename #{n}")));
            }
            LocalFs.rename(from, to).await
        }
        async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
            LocalFs.mkdir(path).await
        }
        async fn trash(&self, path: &Path, _: &str) -> Result<TrashLocation, DuetError> {
            if self.fail_trash {
                return Err(DuetError::NotSupported("injected no recycle bin".into()));
            }
            let dest = self.root.join(format!(
                "trashed-{}",
                path.file_name().unwrap().to_string_lossy()
            ));
            LocalFs.rename(path, &dest).await?;
            Ok(TrashLocation::Local {
                trash_id: dest.to_string_lossy().into_owned(),
            })
        }
        async fn remove(&self, path: &Path) -> Result<(), DuetError> {
            LocalFs.remove(path).await
        }
        async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
            panic!("review fixture never uses OS trash")
        }
        async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError> {
            LocalFs.read_full(path).await
        }
        async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
            LocalFs.write_full(path, bytes).await
        }
        async fn open_read(
            &self,
            path: &Path,
            offset: u64,
        ) -> Result<Pin<Box<dyn AsyncRead + Send>>, DuetError> {
            LocalFs.open_read(path, offset).await
        }
        async fn open_write(
            &self,
            path: &Path,
            offset: u64,
        ) -> Result<Pin<Box<dyn AsyncWrite + Send>>, DuetError> {
            if self.write_limit.is_none() && self.cancel_on_write.is_none() {
                return LocalFs.open_write(path, offset).await;
            }
            assert_eq!(offset, 0, "fault writer is fresh-only");
            Ok(Box::pin(Writer {
                file: std::fs::File::create(path)?,
                left: self.write_limit,
                cancel: self
                    .cancel_on_write
                    .clone()
                    .filter(|_| self.cancel_only.as_deref().is_none_or(|p| p == path)),
            }))
        }
    }

    #[tokio::test]
    async fn c01_policies_and_folder_replace_undo() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a.txt"), b"NEW").unwrap();
        std::fs::write(d.join("a.txt"), b"OLD").unwrap();
        for policy in [
            ConflictPolicy::Skip,
            ConflictPolicy::KeepBoth,
            ConflictPolicy::Replace,
        ] {
            let e = cp(
                &LocalFs,
                &LocalFs,
                &s,
                "a.txt",
                &d,
                policy,
                &c,
                CancellationToken::new(),
            )
            .await
            .unwrap();
            let UndoAction::UndoCopy {
                copied,
                backups_to_restore,
                ..
            } = e.undo
            else {
                panic!()
            };
            assert!(backups_to_restore.is_empty());
            assert_eq!(
                copied.len(),
                if policy == ConflictPolicy::Skip { 0 } else { 1 }
            );
            assert_eq!(
                std::fs::read(d.join("a.txt")).unwrap(),
                if policy == ConflictPolicy::Replace {
                    b"NEW"
                } else {
                    b"OLD"
                }
            );
        }
        assert_eq!(std::fs::read(d.join("a (1).txt")).unwrap(), b"NEW");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 2);
        std::fs::create_dir(s.join("folder")).unwrap();
        std::fs::create_dir(d.join("folder")).unwrap();
        std::fs::write(s.join("folder/new"), b"NEW").unwrap();
        std::fs::write(d.join("folder/only-old"), b"OLD").unwrap();
        let e = cp(
            &LocalFs,
            &LocalFs,
            &s,
            "folder",
            &d,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        let out = crate::core::undo::undo_with_fixture(&e).await;
        assert!(
            matches!(out.kind, crate::core::undo::UndoKind::Ok),
            "{out:?}"
        );
        assert_eq!(std::fs::read(d.join("folder/only-old")).unwrap(), b"OLD");
        assert!(!d.join("folder/new").exists());
    }

    async fn descendant_copy(dst_inside: &str) {
        let t = tempfile::tempdir().unwrap();
        let s = t.path().join("a");
        let d = if dst_inside.is_empty() {
            s.clone()
        } else {
            s.join(dst_inside)
        };
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(s.join("file"), b"payload").unwrap();
        let c = ctx(t.path()).await;
        let plan = copy_plan(&LocalFs, &LocalFs, vec![target(t.path(), "a")], loc(&d)).await;
        assert!(
            matches!(plan, Err(DuetError::IntoItself(_))),
            "plan must reject a destination inside the source: {plan:?}"
        );
        // execute 진입부도 재검사 — plan 단계를 거치지 않은(위조된) plan 도 거부해야 한다.
        let forged = CopyPlan {
            src_source: SourceId::Local,
            dst: loc(&d),
            items: vec![target(t.path(), "a")],
            conflicts: Vec::new(),
            total_size_bytes: 0,
            strategy: CopyStrategy::LocalToLocal,
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            copy_execute(
                &LocalFs,
                &LocalFs,
                forged,
                ConflictPolicy::Skip,
                &c,
                CancellationToken::new(),
                None,
            ),
        )
        .await;
        let mut cursor = d.join("a");
        let mut depth = 0;
        while cursor.is_dir() && depth < 500 {
            depth += 1;
            cursor = if dst_inside.is_empty() {
                cursor.join("a")
            } else {
                cursor.join(dst_inside).join("a")
            };
        }
        let hist = c.journal.history(100).await;
        eprintln!(
            "C02 dst={dst_inside:?} result={result:?} nested_depth={depth} journal_entries={}",
            hist.len()
        );
        assert!(
            matches!(result, Ok(Err(DuetError::IntoItself(_)))),
            "execute must reject a forged plan: {result:?}"
        );
        assert!(hist.is_empty());
        assert_eq!(std::fs::read(s.join("file")).unwrap(), b"payload");
        assert_eq!(
            depth, 0,
            "unsafe self-descendant copy must be rejected before mkdir"
        );
    }
    #[tokio::test]
    async fn c02_reject_copy_into_child() {
        descendant_copy("sub").await;
    }
    #[tokio::test]
    async fn c02_reject_copy_into_itself() {
        descendant_copy("").await;
    }

    #[tokio::test]
    async fn c02_self_file_policies_preserve_original() {
        for policy in [
            ConflictPolicy::Skip,
            ConflictPolicy::KeepBoth,
            ConflictPolicy::Replace,
        ] {
            let t = tempfile::tempdir().unwrap();
            let c = ctx(t.path()).await;
            std::fs::write(t.path().join("a"), b"safe").unwrap();
            let r = cp(
                &LocalFs,
                &LocalFs,
                t.path(),
                "a",
                t.path(),
                policy,
                &c,
                CancellationToken::new(),
            )
            .await;
            eprintln!("C02 self-file policy={policy:?}: {r:?}");
            assert_eq!(std::fs::read(t.path().join("a")).unwrap(), b"safe");
            if policy == ConflictPolicy::Replace {
                assert!(r.is_err());
                assert!(c.journal.history(10).await.is_empty());
            }
            if policy == ConflictPolicy::KeepBoth {
                assert_eq!(std::fs::read(t.path().join("a (1)")).unwrap(), b"safe");
            }
        }
    }
    #[tokio::test]
    async fn c02_move_into_child_preserves_source() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(t.path().join("a/sub")).unwrap();
        std::fs::write(t.path().join("a/file"), b"safe").unwrap();
        let c = ctx(t.path()).await;
        let r = mv(
            &LocalFs,
            &LocalFs,
            t.path(),
            "a",
            &t.path().join("a/sub"),
            &c,
        )
        .await;
        eprintln!("C02 move-descendant: {r:?}");
        assert!(matches!(r, Err(DuetError::IntoItself(_))), "{r:?}");
        assert_eq!(std::fs::read(t.path().join("a/file")).unwrap(), b"safe");
        assert!(c.journal.history(10).await.is_empty());
    }

    #[tokio::test]
    async fn c03_cross_device_success_and_same_fs_partial_failure() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), b"safe").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.cross_from = Some(s.clone());
        let e = mv(&sf, &LocalFs, &s, "a", &d, &c).await.unwrap();
        assert!(!s.join("a").exists());
        assert_eq!(std::fs::read(d.join("a")).unwrap(), b"safe");
        assert_eq!(std::fs::read(t.path().join("trashed-a")).unwrap(), b"safe");
        assert!(matches!(e.undo, UndoAction::UndoMove {ref moved, ..} if moved.len()==1));
        for n in ["x", "z"] {
            std::fs::write(s.join(n), n.as_bytes()).unwrap();
        }
        let items = ["x", "missing", "z"]
            .iter()
            .map(|n| target(&s, n))
            .collect();
        let p = move_plan(&LocalFs, &LocalFs, items, loc(&d)).await.unwrap();
        assert!(move_execute(
            &LocalFs,
            &LocalFs,
            p,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
            None
        )
        .await
        .is_err());
        let h = c.journal.history(10).await;
        assert!(matches!(&h[0].undo, UndoAction::UndoMove {moved, ..} if moved.len()==2));
        assert!(d.join("x").exists() && d.join("z").exists());
    }
    #[tokio::test]
    #[ignore = "fileops-17 repro"]
    async fn c03_trash_failure_must_not_leave_unjournaled_copy() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), b"NEW").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.cross_from = Some(s.clone());
        sf.fail_trash = true;
        let r = mv(&sf, &LocalFs, &s, "a", &d, &c).await;
        let h = c.journal.history(10).await;
        eprintln!(
            "C03 trash-fail: {r:?}; src={} dst={} journal={h:?}",
            s.join("a").exists(),
            d.join("a").exists()
        );
        assert!(r.is_err());
        assert_eq!(std::fs::read(s.join("a")).unwrap(), b"NEW");
        assert!(
            !d.join("a").exists() || !h.is_empty(),
            "completed destination must be rolled back or undoable"
        );
    }
    #[tokio::test]
    async fn c03_replace_file_trash_failure_rolls_back() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), b"NEW").unwrap();
        std::fs::write(d.join("a"), b"OLD").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.cross_from = Some(s.clone());
        sf.fail_trash = true;
        assert!(mv(&sf, &LocalFs, &s, "a", &d, &c).await.is_err());
        assert_eq!(std::fs::read(s.join("a")).unwrap(), b"NEW");
        assert_eq!(std::fs::read(d.join("a")).unwrap(), b"OLD");
        assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1);
    }
    #[tokio::test]
    #[ignore = "fileops-09 repro"]
    async fn c03_replace_folder_trash_failure_restores_target() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::create_dir(s.join("a")).unwrap();
        std::fs::create_dir(d.join("a")).unwrap();
        std::fs::write(s.join("a/new"), b"NEW").unwrap();
        std::fs::write(d.join("a/old"), b"OLD").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.cross_from = Some(s.clone());
        sf.fail_trash = true;
        let r = mv(&sf, &LocalFs, &s, "a", &d, &c).await;
        eprintln!(
            "C03 folder-trash-fail={r:?}, history={:?}",
            c.journal.history(10).await
        );
        assert!(r.is_err());
        assert!(
            d.join("a/old").exists(),
            "old folder must be restored to its original name on failure"
        );
    }

    #[tokio::test]
    #[ignore = "fileops-18 repro"]
    async fn c04_cancel_partial_file_is_tracked_or_cleaned() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), vec![7u8; 8 * 1024 * 1024]).unwrap();
        let token = CancellationToken::new();
        let mut sf = FaultFs::new(t.path());
        sf.stream = true;
        let mut df = FaultFs::new(t.path());
        df.cancel_on_write = Some(token.clone());
        let r = cp(&sf, &df, &s, "a", &d, ConflictPolicy::Replace, &c, token).await;
        let part = d.join("a.duet-part");
        let h = c.journal.history(10).await;
        eprintln!(
            "C04 cancel={r:?}, part_bytes={:?}, journal={h:?}",
            std::fs::metadata(&part).map(|m| m.len())
        );
        assert!(matches!(r, Err(DuetError::Cancelled)));
        assert!(!d.join("a").exists());
        assert!(
            !part.exists() || !h.is_empty(),
            "cancelled file leaves untracked .duet-part"
        );
    }
    #[tokio::test]
    async fn c04_fresh_copy_truncates_stale_part() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), b"new").unwrap();
        std::fs::write(d.join("a.duet-part"), b"stale part with a long suffix").unwrap();
        cp(
            &LocalFs,
            &LocalFs,
            &s,
            "a",
            &d,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(d.join("a")).unwrap(), b"new");
        assert!(!d.join("a.duet-part").exists());
    }
    #[tokio::test]
    #[ignore = "fileops-18 repro"]
    async fn c04_write_failure_restores_old_file_but_leaves_part() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), vec![1u8; 128 * 1024]).unwrap();
        std::fs::write(d.join("a"), b"OLD").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.stream = true;
        let mut df = FaultFs::new(t.path());
        df.write_limit = Some(65536);
        let r = cp(
            &sf,
            &df,
            &s,
            "a",
            &d,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
        )
        .await;
        eprintln!(
            "C04 write failure={r:?}; part={:?}",
            std::fs::metadata(d.join("a.duet-part")).map(|m| m.len())
        );
        assert!(r.is_err());
        assert_eq!(std::fs::read(d.join("a")).unwrap(), b"OLD");
        assert!(
            !d.join("a.duet-part").exists(),
            "failed write leaves 64KiB orphan beside restored original"
        );
    }
    #[tokio::test]
    async fn c04_folder_failure_restores_old_folder() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::create_dir(s.join("a")).unwrap();
        std::fs::create_dir(d.join("a")).unwrap();
        std::fs::write(d.join("a/old"), b"OLD").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.fail_list_at = Some(s.join("a"));
        let r = cp(
            &sf,
            &LocalFs,
            &s,
            "a",
            &d,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
        )
        .await;
        eprintln!("C04 list-fail={r:?}");
        assert!(r.is_err());
        assert_eq!(std::fs::read(d.join("a/old")).unwrap(), b"OLD");
    }

    #[tokio::test]
    #[ignore = "fileops-08 repro"]
    async fn c06_case_only_rename() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path()).await;
        std::fs::write(t.path().join("a.txt"), b"safe").unwrap();
        if !t.path().join("A.txt").exists() {
            eprintln!("SKIP case-only repro: case-sensitive volume");
            return;
        }
        let r = rename(&LocalFs, target(t.path(), "a.txt"), "A.txt".into(), &c).await;
        eprintln!("C06 case-only={r:?}");
        assert!(r.is_ok(), "case-only rename rejected as target exists");
    }
    #[tokio::test]
    async fn c06_rename_must_use_filesystem_name_validation() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path()).await;
        std::fs::write(t.path().join("a"), b"safe").unwrap();
        let name = "nested\\name";
        assert!(LocalFs.validate_new_name(name).is_err());
        let r = rename(&LocalFs, target(t.path(), "a"), name.into(), &c).await;
        eprintln!("C06 invalid-name accepted={r:?}");
        assert!(r.is_err(), "rename bypasses the FileSystem name validator");
    }
    #[tokio::test]
    #[ignore = "fileops-26 repro"]
    async fn c04_preexisting_part_named_user_file_must_survive() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), b"new").unwrap();
        std::fs::write(d.join("a.duet-part"), b"user-owned-data").unwrap();
        let p = copy_plan(&LocalFs, &LocalFs, vec![target(&s, "a")], loc(&d))
            .await
            .unwrap();
        assert!(
            p.conflicts.is_empty(),
            "unrelated .duet-part file is absent from conflict warning"
        );
        copy_execute(
            &LocalFs,
            &LocalFs,
            p,
            ConflictPolicy::Skip,
            &c,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        let survivor = std::fs::read(d.join("a.duet-part"));
        eprintln!("C04 preexisting user .duet-part={survivor:?}");
        assert_eq!(
            survivor.unwrap_or_default(),
            b"user-owned-data",
            "temporary copy path silently clobbers unrelated user data even under Skip"
        );
    }
    #[tokio::test]
    #[ignore = "fileops-08 repro"]
    async fn c07_case_only_batch_rename() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("photo.JPG"), b"safe").unwrap();
        if !t.path().join("photo.jpg").exists() {
            eprintln!("SKIP batch-case repro: case-sensitive volume");
            return;
        }
        let rule = RenameRule {
            case: Some(CaseOp::Lower),
            target_ext: true,
            ..Default::default()
        };
        let p = batch_rename_preview(&LocalFs, vec![target(t.path(), "photo.JPG")], rule)
            .await
            .unwrap();
        eprintln!("C07 case-only preview={p:?}");
        assert!(
            !p.has_collision,
            "own file is marked as collision on case-insensitive volume"
        );
    }
    #[tokio::test]
    async fn c07_batch_preview_must_validate_names() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("a"), b"safe").unwrap();
        let rule = RenameRule {
            base: Some("invalid\0name".into()),
            ..Default::default()
        };
        let p = batch_rename_preview(&LocalFs, vec![target(t.path(), "a")], rule)
            .await
            .unwrap();
        eprintln!("C07 invalid-name preview={p:?}");
        assert!(
            p.has_collision,
            "NUL cannot be a filename, but preview enables Apply"
        );
    }
    #[tokio::test]
    async fn c07_selected_old_name_overlap_is_blocked() {
        let t = tempfile::tempdir().unwrap();
        for name in ["A", "AA"] {
            std::fs::write(t.path().join(name), name.as_bytes()).unwrap();
        }
        let rule = RenameRule {
            find: "A".into(),
            replace: "AA".into(),
            ..Default::default()
        };
        let p = batch_rename_preview(
            &LocalFs,
            vec![target(t.path(), "A"), target(t.path(), "AA")],
            rule,
        )
        .await
        .unwrap();
        assert!(p.has_collision);
        assert!(p.items[0].collision);
        assert_eq!(p.items[0].new_name, "AA");
        assert_eq!(p.items[1].new_name, "AAA");
    }
    #[tokio::test]
    async fn c07_batch_failure_rolls_back_in_reverse() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path()).await;
        for n in ["a", "b", "c"] {
            std::fs::write(t.path().join(n), n.as_bytes()).unwrap();
        }
        let mut fs = FaultFs::new(t.path());
        fs.fail_renames = vec![3];
        let rule = RenameRule {
            prefix: "p_".into(),
            ..Default::default()
        };
        let r = batch_rename_execute(
            &fs,
            ["a", "b", "c"]
                .iter()
                .map(|n| target(t.path(), n))
                .collect(),
            rule,
            &c,
        )
        .await;
        assert!(r.is_err());
        assert_eq!(fs.renames.load(Ordering::SeqCst), 5);
        for n in ["a", "b", "c"] {
            assert_eq!(std::fs::read(t.path().join(n)).unwrap(), n.as_bytes());
            assert!(!t.path().join(format!("p_{n}")).exists());
        }
        assert!(c.journal.history(10).await.is_empty());
    }
    #[tokio::test]
    #[ignore = "fileops-27 repro"]
    async fn c07_batch_rollback_failure_must_be_journaled() {
        let t = tempfile::tempdir().unwrap();
        let c = ctx(t.path()).await;
        for n in ["a", "b", "c"] {
            std::fs::write(t.path().join(n), n.as_bytes()).unwrap();
        }
        let mut fs = FaultFs::new(t.path());
        fs.fail_renames = vec![3, 4];
        let rule = RenameRule {
            prefix: "p_".into(),
            ..Default::default()
        };
        let r = batch_rename_execute(
            &fs,
            ["a", "b", "c"]
                .iter()
                .map(|n| target(t.path(), n))
                .collect(),
            rule,
            &c,
        )
        .await;
        let h = c.journal.history(10).await;
        eprintln!(
            "C07 rollback-failure={r:?}; a={} b={} p_b={} journal={h:?}",
            t.path().join("a").exists(),
            t.path().join("b").exists(),
            t.path().join("p_b").exists()
        );
        assert!(r.is_err());
        assert!(
            t.path().join("b").exists() || !h.is_empty(),
            "partially renamed file has no undo record after ignored rollback error"
        );
    }
    #[tokio::test]
    async fn c02_self_folder_policies_preserve_original() {
        for policy in [
            ConflictPolicy::Skip,
            ConflictPolicy::KeepBoth,
            ConflictPolicy::Replace,
        ] {
            let t = tempfile::tempdir().unwrap();
            let c = ctx(t.path()).await;
            std::fs::create_dir(t.path().join("a")).unwrap();
            std::fs::write(t.path().join("a/file"), b"safe").unwrap();
            let r = cp(
                &LocalFs,
                &LocalFs,
                t.path(),
                "a",
                t.path(),
                policy,
                &c,
                CancellationToken::new(),
            )
            .await;
            assert_eq!(std::fs::read(t.path().join("a/file")).unwrap(), b"safe");
            if policy == ConflictPolicy::KeepBoth {
                assert_eq!(std::fs::read(t.path().join("a (1)/file")).unwrap(), b"safe");
            }
            if policy == ConflictPolicy::Replace {
                assert!(r.is_err());
                assert!(c.journal.history(10).await.is_empty());
            }
        }
    }
    #[tokio::test]
    async fn c04_cancel_journals_completed_top_level_and_undo() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::write(s.join("a"), b"first").unwrap();
        std::fs::write(s.join("b"), vec![8u8; 8 * 1024 * 1024]).unwrap();
        let token = CancellationToken::new();
        let mut sf = FaultFs::new(t.path());
        sf.stream = true;
        let mut df = FaultFs::new(t.path());
        df.cancel_on_write = Some(token.clone());
        df.cancel_only = Some(d.join("b.duet-part"));
        let p = copy_plan(&sf, &df, vec![target(&s, "a"), target(&s, "b")], loc(&d))
            .await
            .unwrap();
        let r = copy_execute(&sf, &df, p, ConflictPolicy::Skip, &c, token, None).await;
        assert!(matches!(r, Err(DuetError::Cancelled)));
        let h = c.journal.history(10).await;
        assert_eq!(h.len(), 1);
        assert!(matches!(&h[0].undo,UndoAction::UndoCopy{copied,..} if copied==&vec![d.join("a")]));
        let out = crate::core::undo::undo_with_fixture(&h[0]).await;
        assert!(matches!(out.kind, crate::core::undo::UndoKind::Ok));
        assert!(!d.join("a").exists());
        assert!(d.join("b.duet-part").exists());
        assert_eq!(std::fs::read(s.join("a")).unwrap(), b"first");
    }
    #[tokio::test]
    #[ignore = "fileops-09 repro"]
    async fn c04_partial_folder_failure_restores_old_folder() {
        let (t, s, d) = setup();
        let c = ctx(t.path()).await;
        std::fs::create_dir_all(s.join("a/zz-block")).unwrap();
        std::fs::create_dir_all(d.join("a")).unwrap();
        std::fs::write(s.join("a/00-file"), b"new").unwrap();
        std::fs::write(d.join("a/old"), b"old").unwrap();
        let mut sf = FaultFs::new(t.path());
        sf.fail_list_at = Some(s.join("a/zz-block"));
        let r = cp(
            &sf,
            &LocalFs,
            &s,
            "a",
            &d,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
        )
        .await;
        eprintln!(
            "C04 partial-folder failure={r:?}; journal={:?}",
            c.journal.history(10).await
        );
        assert!(r.is_err());
        assert!(
            d.join("a/old").exists(),
            "nonempty partial copy prevents rollback to the original name"
        );
    }
}

/// fileops 점검 R2(2026-11-08, opus) — sol/lead 발견 교차 검증용 재현.
/// 모든 파일은 tempdir 안. OS 휴지통·SSH 사용 안 함.
#[cfg(test)]
mod review_fileops_opus_r2 {
    use super::*;
    use crate::fs::LocalFs;
    use tokio_util::sync::CancellationToken;

    async fn mk_ctx(p: &std::path::Path) -> OpCtx {
        OpCtx {
            journal: Journal::load_from(&p.join("r2-journal.jsonl"))
                .await
                .unwrap(),
            settings: SettingsStore::load_from(&p.join("r2-settings.toml"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        }
    }
    fn eref(p: &std::path::Path, name: &str) -> EntryRef {
        EntryRef {
            location: Location {
                source: SourceId::Local,
                path: p.to_path_buf(),
            },
            name: name.into(),
        }
    }
    fn tree_bytes(p: &std::path::Path) -> (u64, u64) {
        let mut files = 0u64;
        let mut bytes = 0u64;
        let mut stack = vec![p.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else {
                continue;
            };
            for e in rd.flatten() {
                let Ok(m) = e.metadata() else { continue };
                if m.is_dir() {
                    stack.push(e.path());
                } else {
                    files += 1;
                    bytes += m.len();
                }
            }
        }
        (files, bytes)
    }

    /// NTFS 처럼 목록을 이름순으로 돌려주는 LocalFs 래퍼 (Windows 디렉터리 열거 순서 모사).
    struct NameOrderFs;
    #[async_trait::async_trait]
    impl FileSystem for NameOrderFs {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        async fn list(&self, p: &std::path::Path) -> Result<Vec<crate::types::Entry>, DuetError> {
            let mut v = LocalFs.list(p).await?;
            v.sort_by_key(|e| e.name.to_lowercase());
            Ok(v)
        }
        async fn metadata(
            &self,
            p: &std::path::Path,
        ) -> Result<crate::types::EntryMeta, DuetError> {
            LocalFs.metadata(p).await
        }
        async fn rename(&self, a: &std::path::Path, b: &std::path::Path) -> Result<(), DuetError> {
            LocalFs.rename(a, b).await
        }
        async fn mkdir(&self, p: &std::path::Path) -> Result<(), DuetError> {
            LocalFs.mkdir(p).await
        }
        async fn trash(&self, _: &std::path::Path, _: &str) -> Result<TrashLocation, DuetError> {
            Err(DuetError::NotSupported("review fixture: no trash".into()))
        }
        async fn remove(&self, _: &std::path::Path) -> Result<(), DuetError> {
            Err(DuetError::NotSupported("review fixture: no remove".into()))
        }
        async fn restore_from_trash(
            &self,
            _: &TrashLocation,
            _: &std::path::Path,
        ) -> Result<(), DuetError> {
            Err(DuetError::NotSupported("review fixture".into()))
        }
        async fn read_full(&self, p: &std::path::Path) -> Result<Vec<u8>, DuetError> {
            LocalFs.read_full(p).await
        }
        async fn write_full(&self, p: &std::path::Path, b: &[u8]) -> Result<(), DuetError> {
            LocalFs.write_full(p, b).await
        }
        async fn open_read(
            &self,
            p: &std::path::Path,
            o: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            LocalFs.open_read(p, o).await
        }
        async fn open_write(
            &self,
            p: &std::path::Path,
            o: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            LocalFs.open_write(p, o).await
        }
    }

    /// fileops-04 (NTFS 이름순 열거): 폴더 `a`(파일 3개 768 KiB + 하위 `zz-sub`)를 `a/zz-sub`
    /// 로 복사하면, 이름순으로 하위 폴더보다 앞에 오는 항목이 단계마다 복제된다.
    #[tokio::test]
    async fn r2_copy_into_child_amplifies_with_name_order_listing() {
        let t = tempfile::tempdir().unwrap();
        let ctx = mk_ctx(t.path()).await;
        let a = t.path().join("a");
        std::fs::create_dir_all(a.join("zz-sub")).unwrap();
        for n in ["aa1.bin", "aa2.bin", "data.bin"] {
            std::fs::write(a.join(n), vec![1u8; 256 * 1024]).unwrap();
        }
        let (_, before) = tree_bytes(&a);
        let fs = NameOrderFs;
        let dst = Location {
            source: SourceId::Local,
            path: a.join("zz-sub"),
        };
        let r = tokio::time::timeout(std::time::Duration::from_secs(120), async {
            let plan = copy_plan(&fs, &fs, vec![eref(t.path(), "a")], dst).await?;
            copy_execute(
                &fs,
                &fs,
                plan,
                ConflictPolicy::Skip,
                &ctx,
                CancellationToken::new(),
                None,
            )
            .await
        })
        .await;
        let (files, after) = tree_bytes(&a);
        let journal = ctx.journal.history(10).await.len();
        assert!(
            matches!(r, Ok(Err(DuetError::IntoItself(_)))),
            "copy into own child must be rejected up front: {r:?}"
        );
        eprintln!(
            "R2 fileops-04 name-order: result={:?} files={files} bytes_before={before} \
             bytes_after={after} amplification=x{} journal={journal}",
            r.as_ref()
                .map(|x| x.as_ref().map(|_| ()).map_err(|e| e.to_string())),
            after / before.max(1)
        );
        assert!(
            after <= before * 2,
            "copy into own child wrote x{} the source size with journal={journal}",
            after / before.max(1)
        );
    }

    /// fileops-19: 일괄 이름 바꾸기 미리보기가 경로 구분자(`\`)가 든 새 이름을 "적용 가능"으로
    /// 표시한다. macOS/Linux 에선 `\` 가 이름 문자지만, Windows 에선 `fs.join` 이 경로로 해석한다
    /// (아래 cfg(windows) 테스트). 미리보기는 OS 와 무관하게 FS validator 로 막아야 한다.
    #[tokio::test]
    async fn r2_batch_preview_flags_backslash_names() {
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join("a.txt"), b"a").unwrap();
        let rule = RenameRule {
            prefix: "..\\".into(),
            ..Default::default()
        };
        let plan = batch_rename_preview(&LocalFs::new(), vec![eref(t.path(), "a.txt")], rule)
            .await
            .unwrap();
        eprintln!("R2 fileops-19 preview: {:?}", plan.items);
        assert!(
            plan.has_collision,
            "new name {:?} with a path separator is offered as applicable",
            plan.items[0].new_name
        );
    }

    /// fileops-19 (Windows 전용 — 이 머신에선 컴파일만): 이름 `..\escaped.txt` 로 바꾸면
    /// 파일이 폴더 밖(상위)으로 옮겨진다. `Path::join` 은 Windows 에서 `\` 를 구분자로 본다.
    #[cfg(windows)]
    #[tokio::test]
    async fn r2_windows_rename_with_backslash_stays_in_folder() {
        let t = tempfile::tempdir().unwrap();
        let ctx = mk_ctx(t.path()).await;
        let inner = t.path().join("inner");
        std::fs::create_dir(&inner).unwrap();
        std::fs::write(inner.join("a.txt"), b"a").unwrap();
        let r = rename(
            &LocalFs::new(),
            eref(&inner, "a.txt"),
            "..\\escaped.txt".into(),
            &ctx,
        )
        .await;
        let escaped = t.path().join("escaped.txt").exists();
        eprintln!("R2 fileops-19 windows: r={r:?} escaped={escaped}");
        assert!(!escaped, "rename moved the file out of its folder");
    }
}

/// sync-compare 점검 라운드(2026-11-08) 재현 테스트 — lead. 제품 코드 변경 없음.
// chmod 로 읽기 실패를 만드는 unix 전용 재현.
#[cfg(all(test, unix))]
mod review_sync_compare_lead {
    use super::*;
    use crate::fs::LocalFs;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    async fn mk_ctx(dir: &std::path::Path) -> OpCtx {
        let settings = crate::services::settings::SettingsStore::load_from(&dir.join("s.toml"))
            .await
            .unwrap();
        let journal = crate::services::journal::Journal::load_from(&dir.join("j.jsonl"))
            .await
            .unwrap();
        OpCtx {
            settings,
            journal,
            pool: None,
            app: None,
        }
    }

    fn loc(p: &std::path::Path) -> Location {
        Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        }
    }

    /// src 에 읽을 수 없는 파일이 하나 있으면 sync 가 중간에 실패한다. 이때
    /// (1) 덮어쓰려던 dst 원본이 제자리에 남아 있어야 하고
    /// (2) 이미 반영된 부분(새 파일·덮어쓴 파일)이 journal 에 남아 Ctrl+Z 할 수 있어야 한다(§4).
    async fn run_failing_sync() -> (
        TempDir,
        std::path::PathBuf,
        Result<JournalEntry, DuetError>,
        OpCtx,
    ) {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a_new.txt"), b"fresh").unwrap();
        std::fs::write(src.join("b_changed.txt"), b"NEW-content").unwrap();
        std::fs::write(dst.join("b_changed.txt"), b"old").unwrap();
        // c: dst 에 사용자 원본(old-c), src 쪽은 크기가 달라 덮어쓰기 대상이지만 읽기 불가.
        std::fs::write(src.join("c_locked.txt"), b"locked-new-content").unwrap();
        std::fs::write(dst.join("c_locked.txt"), b"old-c").unwrap();
        std::fs::set_permissions(
            src.join("c_locked.txt"),
            std::fs::Permissions::from_mode(0o000),
        )
        .unwrap();

        let fs = LocalFs::new();
        let ctx = mk_ctx(dir.path()).await;
        let plan = sync_plan(&fs, &fs, loc(&src), loc(&dst)).await.unwrap();
        let r = sync_execute(
            &fs,
            &fs,
            plan,
            &ctx,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;
        // 정리 가능하도록 권한 복구.
        std::fs::set_permissions(
            src.join("c_locked.txt"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        (dir, dst, r, ctx)
    }

    #[tokio::test]
    async fn review_sync_failure_keeps_dst_original_in_place() {
        let (_dir, dst, r, _ctx) = run_failing_sync().await;
        assert!(r.is_err(), "unreadable src file must fail the sync");
        let names: Vec<String> = std::fs::read_dir(&dst)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            dst.join("c_locked.txt").exists(),
            "dst original vanished from its place after failed sync; dst now = {names:?}"
        );
    }

    #[tokio::test]
    async fn review_sync_failure_journals_partial_progress() {
        let (_dir, _dst, r, ctx) = run_failing_sync().await;
        assert!(r.is_err());
        let hist = ctx.journal.history(10).await;
        assert!(
            !hist.is_empty(),
            "partial sync (new a_new.txt / overwritten b_changed.txt) left no journal entry → Ctrl+Z impossible"
        );
    }
}

/// undo 기록(지문·만든 폴더)과 SC-40(아무것도 안 한 작업은 빈 기록 없음). TempDir 안에서만,
/// undo 는 실행하지 않는다(OS 휴지통 미사용).
#[cfg(test)]
mod undo_record_tests {
    use super::*;
    use crate::fs::LocalFs;
    use tempfile::TempDir;

    async fn ctx(dir: &std::path::Path) -> OpCtx {
        OpCtx {
            settings: crate::services::settings::SettingsStore::load_from(&dir.join("s.toml"))
                .await
                .unwrap(),
            journal: crate::services::journal::Journal::load_from(&dir.join("j.jsonl"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        }
    }

    fn loc(p: &std::path::Path) -> Location {
        Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        }
    }

    /// 왼쪽(L)에만 있는 파일 하나, 오른쪽(R)·base(B)는 비어 있는 트리.
    fn trees() -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let t = TempDir::new().unwrap();
        let (l, r, b) = (t.path().join("L"), t.path().join("R"), t.path().join("B"));
        for d in [&l, &r, &b] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(l.join("only_l.txt"), b"L").unwrap();
        (t, l, r, b)
    }

    fn cancelled() -> tokio_util::sync::CancellationToken {
        let c = tokio_util::sync::CancellationToken::new();
        c.cancel();
        c
    }

    #[tokio::test]
    async fn sc40_cancelled_before_start_leaves_no_journal_entry() {
        let (t, l, r, b) = trees();
        let c = ctx(t.path()).await;
        let fs = LocalFs::new();

        let merged = merge_bidir(&fs, loc(&l), &fs, loc(&r), false, &c, cancelled(), None).await;
        assert!(matches!(merged, Err(DuetError::Cancelled)), "{merged:?}");

        let decisions = vec![ApplyDecision {
            rel: "only_l.txt".into(),
            direction: ApplyDirection::ToRight,
        }];
        let applied =
            apply_compare(&fs, loc(&l), &fs, loc(&r), decisions, &c, cancelled(), None).await;
        assert!(matches!(applied, Err(DuetError::Cancelled)), "{applied:?}");

        let three = apply_three_way(
            &fs,
            loc(&b),
            &fs,
            loc(&l),
            &fs,
            loc(&r),
            &c,
            cancelled(),
            None,
        )
        .await;
        assert!(matches!(three, Err(DuetError::Cancelled)), "{three:?}");

        assert!(!r.join("only_l.txt").exists(), "nothing applied");
        assert!(
            c.journal.history(10).await.is_empty(),
            "SC-40: a cancelled-before-start merge/apply/3-way must not consume a Ctrl+Z slot"
        );
    }

    /// R2-sol-06: 첫 복사가 아무것도 만들기 전에 실패하면(소스 사라짐) 생성 예정 경로만으로
    /// "바뀜"으로 보지 않는다 — 빈 기록 없음.
    #[tokio::test]
    async fn sc40_first_copy_failure_before_creating_leaves_no_journal_entry() {
        let (t, l, r, _b) = trees();
        let c = ctx(t.path()).await;
        let fs = LocalFs::new();
        let decisions = vec![ApplyDecision {
            rel: "missing.txt".into(),
            direction: ApplyDirection::ToRight,
        }];
        let res = apply_compare(
            &fs,
            loc(&l),
            &fs,
            loc(&r),
            decisions,
            &c,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await;
        assert!(res.is_err());
        assert!(!r.join("missing.txt").exists());
        assert!(
            c.journal.history(10).await.is_empty(),
            "SC-40: nothing was created, so nothing should be journaled"
        );
    }

    #[tokio::test]
    async fn merge_and_apply_record_stamps_for_created_items() {
        let (t, l, r, _b) = trees();
        std::fs::write(r.join("over.txt"), b"old").unwrap();
        std::fs::write(l.join("over.txt"), b"newer").unwrap();
        let c = ctx(t.path()).await;
        let fs = LocalFs::new();

        let decisions = vec![
            ApplyDecision {
                rel: "only_l.txt".into(),
                direction: ApplyDirection::ToRight,
            },
            ApplyDecision {
                rel: "over.txt".into(),
                direction: ApplyDirection::ToRight,
            },
        ];
        let e = apply_compare(
            &fs,
            loc(&l),
            &fs,
            loc(&r),
            decisions,
            &c,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        let UndoAction::UndoCompareApply {
            right_created,
            right_created_stamps,
            right_backups,
            ..
        } = &e.undo
        else {
            panic!("wrong variant {:?}", e.undo)
        };
        assert_eq!(right_created_stamps.len(), right_created.len());
        let now = crate::core::stamp::stamp(&fs, &right_created[0])
            .await
            .unwrap();
        assert!(crate::core::stamp::same(
            right_created_stamps[0].as_ref().unwrap(),
            &now
        ));
        // 덮어쓴 자리는 적용 직후(새 내용) 지문.
        let applied = right_backups[0].applied.as_ref().expect("applied stamp");
        assert_eq!(applied.size, Some(5));
    }

    #[tokio::test]
    async fn local_sync_records_created_dirs_and_stamps() {
        let t = TempDir::new().unwrap();
        let (src, dst) = (t.path().join("src"), t.path().join("dst"));
        std::fs::create_dir_all(src.join("newdir/sub")).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("newdir/sub/x.txt"), b"x").unwrap();
        let c = ctx(t.path()).await;
        let fs = LocalFs::new();
        let plan = sync_plan(&fs, &fs, loc(&src), loc(&dst)).await.unwrap();
        let e = sync_execute(
            &fs,
            &fs,
            plan,
            &c,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        let UndoAction::UndoSync {
            created,
            created_stamps,
            created_dirs,
            ..
        } = &e.undo
        else {
            panic!("wrong variant {:?}", e.undo)
        };
        assert_eq!(
            created_dirs,
            &vec![dst.join("newdir"), dst.join("newdir/sub")]
        );
        assert_eq!(created_stamps.len(), created.len());
        assert!(created_stamps.iter().all(Option::is_some));
    }
}

/// U-04 / SC-03: 같은 폴더·상하위 폴더끼리의 이동·동기화·병합·적용·3-way 진입부 가드.
/// 모든 파일은 TempDir 안. 가드가 막는 경로만 실행하므로 OS 휴지통은 부르지 않는다.
#[cfg(test)]
mod nested_roots_guard {
    use super::*;
    use crate::fs::LocalFs;
    use std::path::Path;
    use tokio_util::sync::CancellationToken;

    async fn mk_ctx(dir: &Path) -> OpCtx {
        OpCtx {
            journal: Journal::load_from(&dir.join("g-journal.jsonl"))
                .await
                .unwrap(),
            settings: SettingsStore::load_from(&dir.join("g-settings.toml"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        }
    }
    fn loc(p: &Path) -> Location {
        Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        }
    }
    fn eref(p: &Path, name: &str) -> EntryRef {
        EntryRef {
            location: loc(p),
            name: name.into(),
        }
    }
    fn is_into_itself<T: std::fmt::Debug>(r: &Result<T, DuetError>) -> bool {
        matches!(r, Err(DuetError::IntoItself(_)))
    }
    /// t/p/{a.txt, child/{b.txt}}, 컨텍스트는 t/ctx.
    fn tree() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("p");
        let child = p.join("child");
        std::fs::create_dir_all(&child).unwrap();
        std::fs::create_dir_all(t.path().join("ctx")).unwrap();
        std::fs::write(p.join("a.txt"), b"a").unwrap();
        std::fs::write(child.join("b.txt"), b"b").unwrap();
        (t, p, child)
    }

    #[tokio::test]
    async fn move_execute_rejects_forged_plan_into_child() {
        let (t, p, child) = tree();
        let c = mk_ctx(&t.path().join("ctx")).await;
        let forged = MovePlan {
            src_source: SourceId::Local,
            dst: loc(&child),
            items: vec![eref(t.path(), "p")],
            conflicts: Vec::new(),
            is_same_fs: true,
            total_size_bytes: 0,
            strategy: CopyStrategy::LocalToLocal,
        };
        let r = move_execute(
            &LocalFs,
            &LocalFs,
            forged,
            ConflictPolicy::Replace,
            &c,
            CancellationToken::new(),
            None,
        )
        .await;
        assert!(is_into_itself(&r), "{r:?}");
        assert_eq!(std::fs::read(p.join("a.txt")).unwrap(), b"a");
        assert!(c.journal.history(10).await.is_empty());
    }

    #[tokio::test]
    async fn copy_to_parent_or_sibling_still_allowed() {
        let (t, p, _child) = tree();
        std::fs::create_dir_all(t.path().join("sibling")).unwrap();
        // p/child → p (같은 이름 충돌만 있을 뿐 자기 하위 아님), p → sibling.
        let up = copy_plan(&LocalFs, &LocalFs, vec![eref(&p, "child")], loc(&p)).await;
        assert!(up.is_ok(), "{up:?}");
        let side = copy_plan(
            &LocalFs,
            &LocalFs,
            vec![eref(t.path(), "p")],
            loc(&t.path().join("sibling")),
        )
        .await;
        assert!(side.is_ok(), "{side:?}");
        // 이름이 접두사만 같은 형제(p 와 p2)는 하위가 아니다.
        std::fs::create_dir_all(t.path().join("p2")).unwrap();
        let prefix = copy_plan(
            &LocalFs,
            &LocalFs,
            vec![eref(t.path(), "p")],
            loc(&t.path().join("p2")),
        )
        .await;
        assert!(prefix.is_ok(), "{prefix:?}");
    }

    #[tokio::test]
    async fn sync_plan_rejects_nested_roots_both_directions() {
        let (_t, p, child) = tree();
        for (src, dst) in [(&p, &child), (&child, &p), (&p, &p)] {
            let r = sync_plan(&LocalFs, &LocalFs, loc(src), loc(dst)).await;
            assert!(is_into_itself(&r), "{src:?} -> {dst:?}: {r:?}");
            let pv = sync_preview(&LocalFs, &loc(src), &LocalFs, &loc(dst), None).await;
            assert!(is_into_itself(&pv), "preview {src:?} -> {dst:?}: {pv:?}");
        }
    }

    /// 반대 방향(자식 → 부모) + 삭제 전파: 부모에만 있는 `child` 가 prune 대상이 되어 원본
    /// 루트가 휴지통으로 간다. plan 은 위에서 거부되고, execute 도 위조 plan 을 거부해야 한다.
    /// (prune=false 로 보낸다 — 가드가 없을 때 이 테스트가 OS 휴지통을 부르지 않도록.
    /// 가드는 prune 과 무관하게 진입부에서 동작한다.)
    #[tokio::test]
    async fn sync_execute_rejects_forged_child_to_parent_plan() {
        let (t, p, child) = tree();
        let c = mk_ctx(&t.path().join("ctx")).await;
        let forged = SyncPlan {
            src: loc(&child),
            dst: loc(&p),
            strategy: CopyStrategy::LocalToLocal,
            prune: false,
        };
        let r = sync_execute(
            &LocalFs,
            &LocalFs,
            forged,
            &c,
            CancellationToken::new(),
            None,
        )
        .await;
        assert!(is_into_itself(&r), "{r:?}");
        assert!(!p.join("b.txt").exists(), "nothing may be copied");
        assert_eq!(std::fs::read(child.join("b.txt")).unwrap(), b"b");
        assert!(c.journal.history(10).await.is_empty());
    }

    #[tokio::test]
    async fn merge_and_apply_reject_child_to_parent() {
        let (t, p, child) = tree();
        let c = mk_ctx(&t.path().join("ctx")).await;
        let m = merge_bidir(
            &LocalFs,
            loc(&child),
            &LocalFs,
            loc(&p),
            false,
            &c,
            CancellationToken::new(),
            None,
        )
        .await;
        assert!(is_into_itself(&m), "{m:?}");
        let a = apply_compare(
            &LocalFs,
            loc(&child),
            &LocalFs,
            loc(&p),
            vec![ApplyDecision {
                rel: "b.txt".into(),
                direction: ApplyDirection::ToRight,
            }],
            &c,
            CancellationToken::new(),
            None,
        )
        .await;
        assert!(is_into_itself(&a), "{a:?}");
        assert!(!p.join("b.txt").exists());
        assert!(c.journal.history(10).await.is_empty());
    }

    #[tokio::test]
    async fn three_way_rejects_any_nested_pair() {
        let (t, p, child) = tree();
        let base = t.path().join("base");
        std::fs::create_dir_all(&base).unwrap();
        let other = t.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        let c = mk_ctx(&t.path().join("ctx")).await;
        // (base, left, right) — left/right 상하위, base 가 left 를 품음, base 가 right 안.
        let cases = [
            (base.clone(), p.clone(), child.clone()),
            (p.clone(), child.clone(), other.clone()),
            (base.clone(), other.clone(), base.join(".")),
        ];
        for (b, l, r) in cases {
            let res = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                apply_three_way(
                    &LocalFs,
                    loc(&b),
                    &LocalFs,
                    loc(&l),
                    &LocalFs,
                    loc(&r),
                    &c,
                    CancellationToken::new(),
                    None,
                ),
            )
            .await
            .expect("guard must return immediately");
            assert!(
                is_into_itself(&res),
                "base={b:?} left={l:?} right={r:?}: {res:?}"
            );
        }
        assert!(c.journal.history(10).await.is_empty());
    }
}

/// fileops-19: 일괄 이름 바꾸기 실행도 미리보기와 같은 FS 이름 규칙으로 거부한다.
#[cfg(test)]
mod batch_rename_name_validation {
    use super::*;
    use crate::fs::LocalFs;

    #[tokio::test]
    async fn execute_refuses_separator_and_keeps_files() {
        let t = tempfile::tempdir().unwrap();
        let inner = t.path().join("inner");
        std::fs::create_dir(&inner).unwrap();
        std::fs::write(inner.join("a.txt"), b"a").unwrap();
        let ctx = OpCtx {
            journal: Journal::load_from(&t.path().join("j.jsonl")).await.unwrap(),
            settings: SettingsStore::load_from(&t.path().join("s.toml"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        };
        let item = EntryRef {
            location: Location {
                source: SourceId::Local,
                path: inner.clone(),
            },
            name: "a.txt".into(),
        };
        for prefix in ["..\\", "../", "sub/"] {
            let rule = RenameRule {
                prefix: prefix.into(),
                ..Default::default()
            };
            let r = batch_rename_execute(&LocalFs::new(), vec![item.clone()], rule, &ctx).await;
            assert!(r.is_err(), "{prefix:?}: {r:?}");
            assert!(inner.join("a.txt").exists());
        }
        assert!(ctx.journal.history(10).await.is_empty());
    }
}

#[cfg(test)]
#[path = "ops_paths_tests.rs"]
mod ops_paths_tests;

#[cfg(test)]
mod same_host_hash_tests {
    //! Commands hash stdin so names cannot change the digest token or output line count.
    use super::*;

    #[test]
    fn r3_paths_same_host_hashes_each_input_via_stdin() {
        let paths = [
            PathBuf::from(r"/srv/a\b"),
            PathBuf::from("/srv/line\nbreak"),
            PathBuf::from("/srv/it's"),
        ];
        let cmd = same_host_hash_command(&paths).unwrap();
        for tool in ["sha256sum", "shasum -a 256"] {
            for quoted in [r"'/srv/a\b'", "'/srv/line\nbreak'", r"'/srv/it'\''s'"] {
                assert!(
                    cmd.contains(&format!("LC_ALL=C {tool} < {quoted}")),
                    "{cmd:?}"
                );
            }
        }
        assert!(cmd.contains(" && "));
        assert!(!cmd.contains("sha256sum --"));
    }
}

/// SC-01 `mirror_file`: 복사 실패 뒤 존재 확인이 불확실하면 새 파일을 보수적으로 기록한다.
/// TempDir 안에서만 — 받는 쪽 mock 은 휴지통·영구 삭제를 부르면 panic.
#[cfg(test)]
mod mirror_file_tests {
    use super::*;
    use crate::fs::LocalFs;
    use crate::types::{ConnectionId, Entry, EntryMeta};
    use std::path::Path;
    use std::pin::Pin;

    /// 받는 쪽: 쓰기 도중 실패하면서 최종 이름 자리에 일부를 남기고(부분 쓰기), 그 뒤
    /// lstat 은 NotFound 가 아닌 권한 오류를 낸다 — 존재 여부를 확정할 수 없는 상태.
    /// 원격 SourceId 라 로컬 OS 복사 API 대신 open_write 스트림 경로를 탄다.
    struct PartialWriteFs {
        partial_at: PathBuf,
    }

    #[async_trait::async_trait]
    impl FileSystem for PartialWriteFs {
        fn source_id(&self) -> SourceId {
            SourceId::Ssh {
                connection_id: ConnectionId("fixture".into()),
                host_ip: "127.0.0.1".parse().unwrap(),
                user: "fixture".into(),
            }
        }
        async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
            LocalFs.list(p).await
        }
        async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
            LocalFs.metadata(p).await
        }
        async fn symlink_metadata(&self, _: &Path) -> Result<EntryMeta, DuetError> {
            Err(DuetError::PermissionDenied("injected stat failure".into()))
        }
        async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
            LocalFs.rename(f, t).await
        }
        async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
            LocalFs.mkdir(p).await
        }
        async fn trash(&self, _: &Path, _: &str) -> Result<TrashLocation, DuetError> {
            panic!("fixture never trashes")
        }
        async fn remove(&self, _: &Path) -> Result<(), DuetError> {
            panic!("fixture: permanent removal forbidden")
        }
        async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
            panic!("fixture never restores from trash")
        }
        async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
            LocalFs.read_full(p).await
        }
        async fn write_full(&self, p: &Path, b: &[u8]) -> Result<(), DuetError> {
            LocalFs.write_full(p, b).await
        }
        async fn open_read(
            &self,
            p: &Path,
            o: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            LocalFs.open_read(p, o).await
        }
        async fn open_write(
            &self,
            _: &Path,
            _: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            std::fs::write(&self.partial_at, b"part").map_err(|e| DuetError::Io(e.to_string()))?;
            Err(DuetError::Io("injected: disk full mid-write".into()))
        }
    }

    #[tokio::test]
    async fn new_file_copy_failure_with_uncertain_stat_is_recorded() {
        let t = tempfile::TempDir::new().unwrap();
        let (src, dst) = (t.path().join("src"), t.path().join("dst"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("a.txt"), b"content").unwrap();
        let d = dst.join("a.txt");
        let dst_fs = PartialWriteFs {
            partial_at: d.clone(),
        };
        let mut st = MirrorState {
            created: Vec::new(),
            created_from: Vec::new(),
            created_dirs: Vec::new(),
            backups: Vec::new(),
            done: 0,
            total: 1,
        };
        let r = mirror_file(
            &LocalFs,
            &dst_fs,
            &src.join("a.txt"),
            &d,
            &dst,
            "a.txt",
            false,
            &mut st,
        )
        .await;
        assert!(r.is_err(), "the copy failure is still reported");
        assert!(d.exists(), "fixture left a partial file at the final name");
        assert_eq!(
            st.created,
            vec![d.clone()],
            "uncertain post-failure stat → record the path so undo can clean the partial copy"
        );
        assert_eq!(st.created_from, vec![src.join("a.txt")]);
        assert!(st.backups.is_empty());
    }
}

/// sync relay guard: 지원 밖 조합(relay)은 plan 필드와 무관하게 preview·execute 모두
/// sync_plan 과 같은 오류로 거부되고, 받는 쪽 fs 에 닿지 않는다.
#[cfg(test)]
mod sync_relay_guard_tests {
    use super::*;
    use crate::fs::LocalFs;
    use crate::types::{ConnectionId, Entry, EntryKind, EntryMeta};
    use std::path::Path;
    use std::pin::Pin;

    /// 원격(SSH) 받는 쪽 — 존재 확인 외의 어떤 I/O 도 하면 panic(가드가 먼저 막아야 함).
    struct UntouchableRemoteFs;

    #[async_trait::async_trait]
    impl FileSystem for UntouchableRemoteFs {
        fn source_id(&self) -> SourceId {
            remote_source()
        }
        async fn list(&self, _: &Path) -> Result<Vec<Entry>, DuetError> {
            panic!("relay sync must not list the remote side")
        }
        async fn metadata(&self, _: &Path) -> Result<EntryMeta, DuetError> {
            Ok(EntryMeta {
                kind: EntryKind::Dir,
                size: None,
                modified_ms: None,
                permissions: None,
            })
        }
        async fn rename(&self, _: &Path, _: &Path) -> Result<(), DuetError> {
            panic!("relay sync must not rename on the remote side")
        }
        async fn mkdir(&self, _: &Path) -> Result<(), DuetError> {
            panic!("relay sync must not mkdir on the remote side")
        }
        async fn trash(&self, _: &Path, _: &str) -> Result<TrashLocation, DuetError> {
            panic!("relay sync must not trash on the remote side")
        }
        async fn remove(&self, _: &Path) -> Result<(), DuetError> {
            panic!("fixture: permanent removal forbidden")
        }
        async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
            panic!("fixture never restores from trash")
        }
        async fn read_full(&self, _: &Path) -> Result<Vec<u8>, DuetError> {
            panic!("relay sync must not read the remote side")
        }
        async fn write_full(&self, _: &Path, _: &[u8]) -> Result<(), DuetError> {
            panic!("relay sync must not write the remote side")
        }
        async fn open_read(
            &self,
            _: &Path,
            _: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            panic!("relay sync must not read the remote side")
        }
        async fn open_write(
            &self,
            _: &Path,
            _: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            panic!("relay sync must not write the remote side")
        }
    }

    fn remote_source() -> SourceId {
        SourceId::Ssh {
            connection_id: ConnectionId("fixture".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "fixture".into(),
        }
    }

    fn is_sync_unsupported(r: &Result<impl std::fmt::Debug, DuetError>) -> bool {
        matches!(r, Err(DuetError::NotSupported(m)) if m.contains("sync supports local↔local"))
    }

    async fn ctx(dir: &Path) -> OpCtx {
        OpCtx {
            settings: crate::services::settings::SettingsStore::load_from(&dir.join("s.toml"))
                .await
                .unwrap(),
            journal: crate::services::journal::Journal::load_from(&dir.join("j.jsonl"))
                .await
                .unwrap(),
            pool: None,
            app: None,
        }
    }

    #[tokio::test]
    async fn sync_preview_rejects_local_to_remote_relay() {
        let t = tempfile::TempDir::new().unwrap();
        std::fs::write(t.path().join("a.txt"), b"a").unwrap();
        let src = Location {
            source: SourceId::Local,
            path: t.path().to_path_buf(),
        };
        let dst = Location {
            source: remote_source(),
            path: PathBuf::from("/fixture/dst"),
        };
        let r = sync_preview(&LocalFs, &src, &UntouchableRemoteFs, &dst, None).await;
        assert!(is_sync_unsupported(&r), "{r:?}");
    }

    #[tokio::test]
    async fn sync_execute_rejects_relay_even_when_plan_claims_local() {
        let t = tempfile::TempDir::new().unwrap();
        let src_dir = t.path().join("src");
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::write(src_dir.join("a.txt"), b"a").unwrap();
        let c = ctx(t.path()).await;
        // raw IPC plan — 원격 받는 쪽인데 strategy 를 LocalToLocal·Relay 로 적어 보낸 경우 모두.
        for strategy in [CopyStrategy::LocalToLocal, CopyStrategy::Relay] {
            let plan = SyncPlan {
                src: Location {
                    source: SourceId::Local,
                    path: src_dir.clone(),
                },
                dst: Location {
                    source: remote_source(),
                    path: PathBuf::from("/fixture/dst"),
                },
                strategy,
                prune: true,
            };
            let r = sync_execute(
                &LocalFs,
                &UntouchableRemoteFs,
                plan,
                &c,
                tokio_util::sync::CancellationToken::new(),
                None,
            )
            .await;
            assert!(is_sync_unsupported(&r), "{r:?}");
        }
        assert!(c.journal.history(10).await.is_empty(), "nothing journaled");
    }
}
