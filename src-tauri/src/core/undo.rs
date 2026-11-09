//! UndoAction 종류별 실행. core/ops 가 만든 entry 의 undo 필드를 본문 그대로 적용.
//!
//! 실행 결과는 `UndoOutcome` — UI 가 토스트로 보여주거나 영향받은 location refresh.
//! 결과 분류(`UndoKind`)가 journal 처리를 정한다 (`commands/undo.rs`):
//! - `Ok`/`Partial`/`Irreversible` → 확정(undone). 남은 항목은 영구 사유라 재시도해도 같다.
//! - `Stale` → 아무것도 못 했고 다시 해도 안 됨 — 스택에서 건너뛴다(메모리 표시).
//! - `Error` → 일시 오류. 그대로 남겨 재시도. 진행분은 재시도 때 "이미 처리됨"으로 걸러진다.
//! - `Skipped` → 할 일 없음(되돌릴 것 없음, 다시 실행 미지원).

use crate::fs::{copy_relay, FileSystem, LocalFs, SshFs};
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{JournalEntry, OpKind, UndoAction};
use crate::types::{DuetError, Location, SourceId, TrashLocation};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

mod cleanup;
#[cfg(test)]
pub(crate) use cleanup::testing::undo_with_fixture;
pub use cleanup::{undo_cleanup, FsResolver, PoolFs};

/// undo/redo 한 번의 결과.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UndoOutcome {
    pub kind: UndoKind,
    /// 무엇을 되돌렸/다시 했는지 — `commands/undo.rs` 가 entry 의 op 로 채운다.
    pub op: Option<OpKind>,
    /// `kind` 가 `Ok` 가 아닐 때의 대표 사유. FE 가 i18n 문구로 바꾼다.
    pub reason: Option<UndoReason>,
    /// 항목별로 건너뛴 것 (`Partial`/`Stale`).
    pub skipped: Vec<UndoSkip>,
    /// 백엔드 원문 상세(오류 원문 등) — 보조 표시용. 주 문구는 FE 가 kind·reason 으로 만든다.
    pub message: Option<String>,
    pub refreshed_locations: Vec<Location>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UndoKind {
    /// 전부 되돌림(또는 할 일이 이미 끝나 있음).
    Ok,
    /// 일부만 되돌림 — 나머지는 `skipped` 에 영구 사유.
    Partial,
    /// 아무것도 못 했고 다시 해도 안 됨 — 스택에서 건너뛴다.
    Stale,
    /// 할 일 없음 (되돌릴 것 없음 / 다시 실행 미지원). journal 불변.
    Skipped,
    /// 원래 되돌릴 수 없는 작업으로 기록됨.
    Irreversible,
    /// 일시 오류 — journal 불변, 재시도 가능.
    Error,
}

/// 결과·건너뜀 사유 코드. 문구는 FE i18n.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum UndoReason {
    NothingToUndo,
    NothingToRedo,
    RedoUnsupported,
    /// 기록 뒤 내용이 바뀜 — 지우면 그 뒤 작업을 잃는다.
    Changed,
    /// 되돌릴 대상이 없어짐.
    Gone,
    /// 되돌릴 자리에 다른 항목이 생김 — 덮어쓰지 않는다.
    Occupied,
    /// 구버전 기록이라 바뀌었는지 확인할 수 없음.
    Unverifiable,
    /// 이 OS 에서는 앱이 휴지통 복원을 못 함 (macOS — Finder 에서 직접).
    TrashRestoreUnsupported,
    /// 연결할 수 없음.
    Unreachable,
    /// 기타 오류 (`message` 에 원문).
    Failed,
}

/// 항목별 건너뜀.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct UndoSkip {
    pub path: PathBuf,
    pub reason: UndoReason,
}

/// 항목 하나의 처리 결과 — 영구 사유로 건너뛴 경우는 `Skip`. 일시 오류는 `Err` 로 따로.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    Done,
    Skip(UndoReason),
}

/// 항목별 진행 누적 — 끝에 `Ok`/`Partial`/`Stale` 를 판정한다.
#[derive(Default)]
pub(crate) struct Tally {
    done: usize,
    skipped: Vec<UndoSkip>,
    refresh: HashSet<(SourceId, PathBuf)>,
    notes: Vec<String>,
}

impl Tally {
    /// 항목 결과 기록. `Done` 이면 그 부모 폴더를 새로고침 대상에 넣는다.
    pub(crate) fn record(&mut self, step: Step, source: &SourceId, path: &Path) {
        match step {
            Step::Done => {
                self.done += 1;
                self.refresh_parent(source, path);
            }
            Step::Skip(reason) => self.skip(path, reason),
        }
    }

    pub(crate) fn skip(&mut self, path: &Path, reason: UndoReason) {
        self.skipped.push(UndoSkip {
            path: path.to_path_buf(),
            reason,
        });
    }

    pub(crate) fn refresh_parent(&mut self, source: &SourceId, path: &Path) {
        if let Some(p) = path.parent() {
            self.refresh.insert((source.clone(), p.to_path_buf()));
        }
    }

    /// 사용자에게 덧붙일 원문 메모 (예: 수동 복원 안내).
    pub(crate) fn note(&mut self, text: impl Into<String>) {
        self.notes.push(text.into());
    }

    /// 건너뜀 없음 → Ok, 일부 처리 → Partial, 하나도 못 함 → Stale.
    pub(crate) fn finish(self) -> UndoOutcome {
        let reason = self.skipped.first().map(|s| s.reason);
        let kind = match (self.skipped.is_empty(), self.done) {
            (true, _) => UndoKind::Ok,
            (false, 0) => UndoKind::Stale,
            (false, _) => UndoKind::Partial,
        };
        UndoOutcome {
            kind,
            op: None,
            reason,
            skipped: self.skipped,
            message: (!self.notes.is_empty()).then(|| self.notes.join("\n")),
            refreshed_locations: self
                .refresh
                .into_iter()
                .map(|(source, path)| Location { source, path })
                .collect(),
        }
    }

    /// 일시 오류로 중단 — 진행분 새로고침은 유지하고 Error 로.
    pub(crate) fn fail(self, prefix: &str, e: DuetError) -> UndoOutcome {
        let mut out = error(prefix, e);
        out.skipped = self.skipped;
        out.refreshed_locations = self
            .refresh
            .into_iter()
            .map(|(source, path)| Location { source, path })
            .collect();
        out
    }
}

/// 대상이 이미 있으면 덮어쓰지 않는 rename (U-10).
///
/// `from` 없음 → `Skip(Gone)`, `to` 에 무엇이든 있음(링크 포함) → `Skip(Occupied)`.
/// 확인과 rename 사이 짧은 경쟁 창은 남는다 — 로컬 원자적 no-replace(renameat2/renamex_np)는
/// `fs/local.rs` 소관이라 후속. `CrossDevice` 등 rename 오류는 그대로 `Err` 로 넘긴다.
pub(crate) async fn rename_no_replace(
    fs: &dyn FileSystem,
    from: &Path,
    to: &Path,
) -> Result<Step, DuetError> {
    match fs.symlink_metadata(from).await {
        Ok(_) => {}
        Err(DuetError::NotFound(_)) => return Ok(Step::Skip(UndoReason::Gone)),
        Err(e) => return Err(e),
    }
    match fs.symlink_metadata(to).await {
        Ok(_) if !case_only_alias(fs, from, to).await? => {
            return Ok(Step::Skip(UndoReason::Occupied))
        }
        Ok(_) | Err(DuetError::NotFound(_)) => {}
        Err(e) => return Err(e),
    }
    fs.rename(from, to).await?;
    Ok(Step::Done)
}

/// `to` 가 `from` 자신을 대소문자만 다르게 부른 것인지 (대소문자 무시 볼륨의 `a.txt`↔`A.txt`).
///
/// 같은 폴더·대소문자만 다른 이름일 때 폴더 목록에 `to` 이름이 **정확히** 없으면 자기 자신이다
/// (대소문자 구분 볼륨에서 둘 다 있으면 목록에 둘 다 보여 점유로 판정).
async fn case_only_alias(fs: &dyn FileSystem, from: &Path, to: &Path) -> Result<bool, DuetError> {
    let (Some(dir), Some(from_name), Some(to_name)) =
        (from.parent(), from.file_name(), to.file_name())
    else {
        return Ok(false);
    };
    let (from_name, to_name) = (from_name.to_string_lossy(), to_name.to_string_lossy());
    if to.parent() != Some(dir)
        || from_name == to_name
        || from_name.to_lowercase() != to_name.to_lowercase()
    {
        return Ok(false);
    }
    let entries = fs.list(dir).await?;
    Ok(!entries.iter().any(|e| e.name == to_name))
}

/// 항목 하나를 `from` → `to` 로 옮긴다 (undo/redo 의 move 공용). 덮어쓰지 않는다.
///
/// 같은 source 면 no-replace rename. 드라이브가 달라 `CrossDevice` 거나 source 가 다르면
/// 복사 후 남은 쪽을 **휴지통**으로(원래 move 폴백과 동일) — 복사가 끝난 뒤의 휴지통 실패는
/// 데이터가 이미 `to` 에 있으므로 Done 으로 치고 남은 사본 위치를 `t` 의 메모로 알린다.
async fn move_item(
    t: &mut Tally,
    from_fs: &dyn FileSystem,
    from: &Path,
    to_fs: &dyn FileSystem,
    to: &Path,
    same_source: bool,
) -> Result<Step, DuetError> {
    if same_source {
        match rename_no_replace(from_fs, from, to).await {
            Err(DuetError::CrossDevice(_)) => {}
            other => return other,
        }
    }
    match from_fs.symlink_metadata(from).await {
        Ok(_) => {}
        Err(DuetError::NotFound(_)) => return Ok(Step::Skip(UndoReason::Gone)),
        Err(e) => return Err(e),
    }
    match to_fs.symlink_metadata(to).await {
        Ok(_) => return Ok(Step::Skip(UndoReason::Occupied)),
        Err(DuetError::NotFound(_)) => {}
        Err(e) => return Err(e),
    }
    copy_relay(from_fs, from, to_fs, to).await?;
    if let Err(e) = from_fs
        .trash(from, &crate::services::trash::new_batch_id())
        .await
    {
        t.note(format!(
            "moved back, but the copy at {} could not be moved to trash: {e}",
            from.display()
        ));
    }
    Ok(Step::Done)
}

/// 백업을 원래 자리로 (덮어쓰지 않음). 백업이 이미 없으면 `None` — 복원할 것 없음.
async fn restore_backup(
    fs: &dyn FileSystem,
    backup: &Path,
    original: &Path,
) -> Result<Option<Step>, DuetError> {
    match fs.symlink_metadata(backup).await {
        Ok(_) => rename_no_replace(fs, backup, original).await.map(Some),
        Err(DuetError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
}

/// move/rename 결과를 기록 — 건너뜀 사유에 맞는 경로를 남긴다(사라짐 → 출발지, 점유 → 도착지).
fn record_move(
    t: &mut Tally,
    step: Step,
    (from_source, from): (&SourceId, &Path),
    (to_source, to): (&SourceId, &Path),
) {
    match step {
        Step::Done => {
            t.record(step, to_source, to);
            t.refresh_parent(from_source, from);
        }
        Step::Skip(UndoReason::Gone) => t.record(step, from_source, from),
        Step::Skip(_) => t.record(step, to_source, to),
    }
}

/// Never permanently remove a file checked before a concurrent writer can change it.
async fn undo_new_file(
    fs: &dyn FileSystem,
    source: &SourceId,
    path: &std::path::Path,
) -> UndoOutcome {
    match fs.symlink_metadata(path).await {
        Ok(m) if matches!(m.kind, crate::types::EntryKind::File) && m.size == Some(0) => {}
        Ok(_) => return stale(UndoReason::Changed, path),
        Err(DuetError::NotFound(_)) => return stale(UndoReason::Gone, path),
        Err(e) => return error("inspect new file", e),
    }
    // If a writer races the check, the content remains recoverable in the trash.
    if let Err(e) = fs
        .trash(path, &crate::services::trash::new_batch_id())
        .await
    {
        return error("move new file to trash", e);
    }
    ok_with_locs(
        source,
        path.parent().map(|p| p.to_path_buf()).into_iter().collect(),
    )
}

async fn undo_new_dir(
    fs: &dyn FileSystem,
    source: &SourceId,
    path: &std::path::Path,
) -> UndoOutcome {
    match fs.list(path).await {
        Ok(entries) if !entries.is_empty() => return stale(UndoReason::Changed, path),
        Ok(_) => {}
        Err(DuetError::NotFound(_)) => return stale(UndoReason::Gone, path),
        Err(e) => return error("inspect new directory", e),
    }
    // rmdir itself refuses children added after the list; recursive remove is unsafe here.
    if let Err(e) = fs.remove_empty_dir(path).await {
        return error("remove empty directory", e);
    }
    ok_with_locs(
        source,
        path.parent().map(|p| p.to_path_buf()).into_iter().collect(),
    )
}

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

pub async fn execute_undo(entry: &JournalEntry, pool: &Arc<ConnectionPool>) -> UndoOutcome {
    match &entry.undo {
        // 영구삭제·재귀 chmod·chown 등 — push 시점에 Irreversible 로 기록된 작업 공통.
        UndoAction::Irreversible => UndoOutcome {
            kind: UndoKind::Irreversible,
            ..bare("This operation cannot be undone")
        },
        UndoAction::UndoChmod { source, items } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            let mut refresh = std::collections::HashSet::new();
            for item in items {
                if let Err(e) = fs.set_mode(&item.path, item.old_mode, false).await {
                    return error("chmod restore", e);
                }
                if let Some(p) = item.path.parent() {
                    refresh.insert(p.to_path_buf());
                }
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoSymlink { source, path } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 여전히 심볼릭 링크일 때만 제거 — 사용자가 그 자리에 딴 걸 만들었으면 스킵.
            match fs.symlink_metadata(path).await {
                Ok(m) if matches!(m.kind, crate::types::EntryKind::Symlink) => {}
                Ok(_) => return stale(UndoReason::Changed, path),
                Err(DuetError::NotFound(_)) => return stale(UndoReason::Gone, path),
                Err(e) => return error("inspect symlink", e),
            }
            if let Err(e) = fs.remove(path).await {
                return error("remove symlink", e);
            }
            let mut refresh = std::collections::HashSet::new();
            if let Some(p) = path.parent() {
                refresh.insert(p.to_path_buf());
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoNewFile { source, path } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            undo_new_file(&*fs, source, path).await
        }
        UndoAction::RestoreFromTrash { source, items } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 배치 복원 — 로컬은 휴지통 목록 조회를 항목마다 하지 않고 1회로 끝낸다.
            let batch: Vec<(TrashLocation, PathBuf)> = items
                .iter()
                .map(|item| {
                    let loc = match source {
                        SourceId::Local => TrashLocation::Local {
                            trash_id: item.trash_path.clone(),
                        },
                        SourceId::Ssh { .. } => TrashLocation::Remote {
                            trash_path: PathBuf::from(&item.trash_path),
                        },
                    };
                    (loc, item.original_path.clone())
                })
                .collect();
            match fs.restore_many(&batch).await {
                Ok(()) => {}
                // macOS: 앱이 휴지통 복원을 못 한다 — 재시도해도 같으니 건너뛰고 Finder 안내(fileops-07).
                Err(DuetError::NotSupported(msg)) => {
                    let mut out = stale_items(
                        UndoReason::TrashRestoreUnsupported,
                        items.iter().map(|i| i.original_path.as_path()),
                    );
                    out.message = Some(msg);
                    return out;
                }
                Err(e) => return error("restore failed", e),
            }
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for item in items {
                if let Some(parent) = item.original_path.parent() {
                    refresh.insert(parent.to_path_buf());
                }
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoCopy { .. }
        | UndoAction::UndoSync { .. }
        | UndoAction::UndoBidirMerge { .. }
        | UndoAction::UndoCompareApply { .. }
        | UndoAction::UndoThreeWayApply { .. } => {
            // 생성분 정리 계열 — 지문이 같을 때만 휴지통으로 (cleanup.rs, G-01).
            match cleanup::undo_cleanup(entry, &PoolFs(pool)).await {
                Some(out) => out,
                None => nothing(UndoReason::NothingToUndo),
            }
        }
        UndoAction::UndoMove {
            src_source,
            dst_source,
            moved,
            backups_to_restore,
        } => {
            let (src_fs, dst_fs) = match (
                fs_for(src_source, pool).await,
                fs_for(dst_source, pool).await,
            ) {
                (Ok(a), Ok(b)) => (a, b),
                (Err(e), _) | (_, Err(e)) => return error("source unreachable", e),
            };
            // 항목별로 되돌리고 결과를 모은다 — 하나가 사라졌다고 나머지를 버리지 않고(fileops-22),
            // 원래 자리에 새 항목이 생겼으면 덮어쓰지 않는다(U-10).
            let mut t = Tally::default();
            for m in moved {
                let step = match move_item(
                    &mut t,
                    &*dst_fs,
                    &m.dst_now,
                    &*src_fs,
                    &m.src_original,
                    src_source == dst_source,
                )
                .await
                {
                    Ok(s) => s,
                    Err(e) => return t.fail("move back", e),
                };
                record_move(
                    &mut t,
                    step,
                    (dst_source, &m.dst_now),
                    (src_source, &m.src_original),
                );
            }
            // 폴더 교체 이동의 백업 — 이동분이 빠져 자리가 비었을 때만 제자리로.
            for b in backups_to_restore {
                match restore_backup(&*dst_fs, &b.backup_path, &b.original_path).await {
                    Ok(Some(step)) => {
                        if step != Step::Done {
                            t.note(format!("backup kept at {}", b.backup_path.display()));
                        }
                        record_move(
                            &mut t,
                            step,
                            (dst_source, &b.backup_path),
                            (dst_source, &b.original_path),
                        );
                    }
                    Ok(None) => {}
                    Err(e) => return t.fail("restore backup", e),
                }
            }
            t.finish()
        }
        UndoAction::UndoRename {
            source,
            current,
            original,
        } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            let mut t = Tally::default();
            match rename_no_replace(&*fs, current, original).await {
                Ok(step) => record_move(&mut t, step, (source, current), (source, original)),
                Err(e) => return error("rename back", e),
            }
            t.finish()
        }
        UndoAction::UndoBatchRename { source, pairs } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 역순으로 current → original 복원. forward 에서 new==old 겹침을 차단했으므로
            // 순서 무관하게 복원 가능. 점유·사라짐은 그 항목만 건너뛴다(U-10).
            let mut t = Tally::default();
            for p in pairs.iter().rev() {
                match rename_no_replace(&*fs, &p.current, &p.original).await {
                    Ok(step) => {
                        record_move(&mut t, step, (source, &p.current), (source, &p.original))
                    }
                    Err(e) => return t.fail("rename back", e),
                }
            }
            t.finish()
        }
        UndoAction::UndoMkdir { source, path } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            undo_new_dir(&*fs, source, path).await
        }
    }
}

/// 되돌린(undone) entry 의 **원래 작업을 재적용** (redo).
///
/// 1단계 지원 범위 — journal 데이터만으로 안전하게 재실행 가능한 것:
/// - Move: `MoveItem{src_original → dst_now}` 재이동. 단 원래 이동이 덮어쓰기
///   (.bak 백업)를 동반했다면 재이동이 복원된 대상 파일과 충돌 → 미지원.
/// - Rename / BatchRename: original → current 재적용.
/// - Mkdir: 재생성.
/// - Chmod(비재귀): op 에 기록된 새 mode 재적용.
///
/// 미지원(Skipped 로 안내): Copy/Sync/Merge/CompareApply/ThreeWayApply(소스 경로
/// 미기록), Symlink(target 미기록), Trash(재삭제 시 휴지통 id 가 바뀌어 이후
/// undo 의 기록이 스테일해짐 — §4 위반 위험).
pub async fn execute_redo(entry: &JournalEntry, pool: &Arc<ConnectionPool>) -> UndoOutcome {
    match &entry.undo {
        UndoAction::UndoRename {
            source,
            current,
            original,
        } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            let mut t = Tally::default();
            match rename_no_replace(&*fs, original, current).await {
                Ok(step) => record_move(&mut t, step, (source, original), (source, current)),
                Err(e) => return error("rename forward", e),
            }
            t.finish()
        }
        UndoAction::UndoBatchRename { source, pairs } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // forward 순서로 original → current 재적용 (undo 는 역순이었음). 새 파일이 생긴
            // 이름은 덮어쓰지 않고 그 항목만 건너뛴다(U-10).
            let mut t = Tally::default();
            for p in pairs.iter() {
                match rename_no_replace(&*fs, &p.original, &p.current).await {
                    Ok(step) => {
                        record_move(&mut t, step, (source, &p.original), (source, &p.current))
                    }
                    Err(e) => return t.fail("rename forward", e),
                }
            }
            t.finish()
        }
        UndoAction::UndoMkdir { source, path } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            if fs.metadata(path).await.is_ok() {
                return stale(UndoReason::Occupied, path);
            }
            if let Err(e) = fs.mkdir(path).await {
                return error("mkdir", e);
            }
            let mut refresh = std::collections::HashSet::new();
            if let Some(p) = path.parent() {
                refresh.insert(p.to_path_buf());
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoNewFile { source, path } => {
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            // 자리에 뭔가 있으면 덮어쓰지 않는다 (write_full 은 truncate).
            if fs.symlink_metadata(path).await.is_ok() {
                return stale(UndoReason::Occupied, path);
            }
            if let Err(e) = fs.create_new_file(path).await {
                return error("create file", e);
            }
            let mut refresh = std::collections::HashSet::new();
            if let Some(p) = path.parent() {
                refresh.insert(p.to_path_buf());
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoChmod { source, items } => {
            // 재적용할 새 mode 는 op 에만 기록돼 있음 (undo 데이터는 old_mode).
            let mode = match &entry.op {
                crate::services::journal::OpKind::Chmod {
                    mode,
                    recursive: false,
                    ..
                } => *mode,
                _ => return unsupported(),
            };
            let fs = match fs_for(source, pool).await {
                Ok(f) => f,
                Err(e) => return error("source unreachable", e),
            };
            let mut refresh = std::collections::HashSet::new();
            for item in items {
                if let Err(e) = fs.set_mode(&item.path, mode, false).await {
                    return error("chmod forward", e);
                }
                if let Some(p) = item.path.parent() {
                    refresh.insert(p.to_path_buf());
                }
            }
            ok_with_locs(source, refresh)
        }
        UndoAction::UndoMove {
            src_source,
            dst_source,
            moved,
            backups_to_restore,
        } => {
            // 덮어쓰기 동반 이동은 재이동 시 복원된 대상과 충돌 — 1단계 미지원.
            if !backups_to_restore.is_empty() {
                return unsupported();
            }
            let (src_fs, dst_fs) = match (
                fs_for(src_source, pool).await,
                fs_for(dst_source, pool).await,
            ) {
                (Ok(a), Ok(b)) => (a, b),
                (Err(e), _) | (_, Err(e)) => return error("source unreachable", e),
            };
            // undo 와 대칭 — 항목별, 덮어쓰지 않음.
            let mut t = Tally::default();
            for m in moved {
                let step = match move_item(
                    &mut t,
                    &*src_fs,
                    &m.src_original,
                    &*dst_fs,
                    &m.dst_now,
                    src_source == dst_source,
                )
                .await
                {
                    Ok(s) => s,
                    Err(e) => return t.fail("move forward", e),
                };
                record_move(
                    &mut t,
                    step,
                    (src_source, &m.src_original),
                    (dst_source, &m.dst_now),
                );
            }
            t.finish()
        }
        UndoAction::UndoCopy {
            target_source,
            copied,
            backups_to_restore,
            src_source,
            copied_from,
            ..
        } => {
            // 덮어쓰기 동반 복사는 undo 가 백업을 복원했으므로 재복사가 충돌 — 미지원.
            if !backups_to_restore.is_empty() {
                return unsupported();
            }
            // 2단계에서 기록 시작 — 구버전 entry/아카이브 추출은 src 미기록.
            let Some(src_source) = src_source else {
                return unsupported();
            };
            if copied_from.len() != copied.len() || copied.is_empty() {
                return unsupported();
            }
            let src_fs_r = fs_for(src_source, pool).await;
            let dst_fs_r = fs_for(target_source, pool).await;
            let (src_fs, dst_fs) = match (src_fs_r, dst_fs_r) {
                (Ok(a), Ok(b)) => (a, b),
                _ => return unreachable(),
            };
            for (src, dst) in copied_from.iter().zip(copied.iter()) {
                if src_fs.metadata(src).await.is_err() {
                    return stale(UndoReason::Gone, src);
                }
                if dst_fs.metadata(dst).await.is_ok() {
                    return stale(UndoReason::Occupied, dst);
                }
                if let Err(e) = copy_relay(&*src_fs, src, &*dst_fs, dst).await {
                    return error("copy forward", e);
                }
            }
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for dst in copied {
                if let Some(p) = dst.parent() {
                    refresh.insert(p.to_path_buf());
                }
            }
            ok_with_locs(target_source, refresh)
        }
        UndoAction::UndoSync {
            dst_source,
            created,
            backups_to_restore,
            pruned,
            src_source,
            created_from,
            ..
        } => {
            // 순수 추가형(덮어쓰기·prune 없음) sync 만 redo — 그 외는 재실행 시
            // 백업/휴지통 기록이 스테일해짐.
            if !backups_to_restore.is_empty() || !pruned.is_empty() {
                return unsupported();
            }
            let Some(src_source) = src_source else {
                return unsupported();
            };
            if created_from.len() != created.len() || created.is_empty() {
                return unsupported();
            }
            let src_fs_r = fs_for(src_source, pool).await;
            let dst_fs_r = fs_for(dst_source, pool).await;
            let (src_fs, dst_fs) = match (src_fs_r, dst_fs_r) {
                (Ok(a), Ok(b)) => (a, b),
                _ => return unreachable(),
            };
            for (src, dst) in created_from.iter().zip(created.iter()) {
                if src_fs.metadata(src).await.is_err() {
                    return stale(UndoReason::Gone, src);
                }
                if dst_fs.metadata(dst).await.is_ok() {
                    continue; // 이미 있음(사용자가 재동기화 등) — 건너뜀
                }
                if let Err(e) = copy_relay(&*src_fs, src, &*dst_fs, dst).await {
                    return error("copy forward", e);
                }
            }
            let mut refresh = std::collections::HashSet::<PathBuf>::new();
            for dst in created {
                if let Some(p) = dst.parent() {
                    refresh.insert(p.to_path_buf());
                }
            }
            ok_with_locs(dst_source, refresh)
        }
        UndoAction::UndoBidirMerge {
            left_source,
            right_source,
            left_pairs,
            right_pairs,
            ..
        } => {
            // 구버전 entry(쌍 미기록)는 미지원. 머지는 충돌을 안 건드리므로 항상 추가형.
            if left_pairs.is_empty() && right_pairs.is_empty() {
                return unsupported();
            }
            redo_pair_copies(
                pool,
                // left_pairs: from=right 측 → to=left 측 / right_pairs 는 반대.
                &[
                    (right_source, left_source, left_pairs),
                    (left_source, right_source, right_pairs),
                ],
            )
            .await
        }
        UndoAction::UndoCompareApply {
            left_source,
            right_source,
            left_backups,
            right_backups,
            left_pairs,
            right_pairs,
            ..
        } => {
            // 덮어쓰기 동반 적용은 undo 가 백업을 복원했으므로 재적용 충돌 — 미지원.
            if !left_backups.is_empty() || !right_backups.is_empty() {
                return unsupported();
            }
            if left_pairs.is_empty() && right_pairs.is_empty() {
                return unsupported();
            }
            redo_pair_copies(
                pool,
                &[
                    (right_source, left_source, left_pairs),
                    (left_source, right_source, right_pairs),
                ],
            )
            .await
        }
        // ThreeWayApply/Symlink/Trash/Irreversible —
        // 소스 경로·타깃 미기록 또는 재실행 시 journal 데이터가 스테일해짐.
        _ => unsupported(),
    }
}

/// (from_source, to_source, pairs) 그룹들을 재복사 — merge/compare-apply redo 공용.
/// 이미 존재하는 대상은 항목 단위 skip (재적용 후 redo 안전).
async fn redo_pair_copies(
    pool: &Arc<ConnectionPool>,
    groups: &[(
        &SourceId,
        &SourceId,
        &Vec<crate::services::journal::RedoCopyPair>,
    )],
) -> UndoOutcome {
    let mut refresh = std::collections::HashSet::<(SourceId, PathBuf)>::new();
    for (from_source, to_source, pairs) in groups {
        if pairs.is_empty() {
            continue;
        }
        let from_fs = match fs_for(from_source, pool).await {
            Ok(f) => f,
            Err(e) => return error("source unreachable", e),
        };
        let to_fs = match fs_for(to_source, pool).await {
            Ok(f) => f,
            Err(e) => return error("source unreachable", e),
        };
        for p in pairs.iter() {
            if from_fs.metadata(&p.from).await.is_err() {
                return stale(UndoReason::Gone, &p.from);
            }
            if to_fs.metadata(&p.to).await.is_ok() {
                continue;
            }
            if let Err(e) = copy_relay(&*from_fs, &p.from, &*to_fs, &p.to).await {
                return error("copy forward", e);
            }
            if let Some(par) = p.to.parent() {
                refresh.insert(((*to_source).clone(), par.to_path_buf()));
            }
        }
    }
    ok_multi(refresh)
}

/// 필드가 빈 결과 — 각 생성자가 kind·reason 을 덮어쓴다.
fn bare(message: &str) -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Skipped,
        op: None,
        reason: None,
        skipped: vec![],
        message: Some(message.into()),
        refreshed_locations: vec![],
    }
}

/// 다시 실행 미지원 (journal 데이터로 안전하게 재실행 못 하는 op).
fn unsupported() -> UndoOutcome {
    UndoOutcome {
        reason: Some(UndoReason::RedoUnsupported),
        ..bare("This operation can't be redone")
    }
}

/// 하나뿐인 대상이 영구 사유로 처리 불가 — 스택에서 건너뛴다.
pub(crate) fn stale(reason: UndoReason, path: &Path) -> UndoOutcome {
    stale_items(reason, std::iter::once(path))
}

/// 여러 대상이 모두 같은 영구 사유로 처리 불가.
pub(crate) fn stale_items<'a>(
    reason: UndoReason,
    paths: impl IntoIterator<Item = &'a Path>,
) -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Stale,
        op: None,
        reason: Some(reason),
        skipped: paths
            .into_iter()
            .map(|p| UndoSkip {
                path: p.to_path_buf(),
                reason,
            })
            .collect(),
        message: None,
        refreshed_locations: vec![],
    }
}

/// 일시 오류 — 재시도 가능. 연결 문제면 `Unreachable`, 그 외 `Failed`.
pub(crate) fn error(prefix: &str, e: DuetError) -> UndoOutcome {
    let reason = match e {
        DuetError::ConnectionFailed(_) | DuetError::Ssh(_) | DuetError::AuthFailed => {
            UndoReason::Unreachable
        }
        _ => UndoReason::Failed,
    };
    UndoOutcome {
        kind: UndoKind::Error,
        reason: Some(reason),
        ..bare(&format!("{prefix}: {e}"))
    }
}

fn unreachable() -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Error,
        reason: Some(UndoReason::Unreachable),
        ..bare("source unreachable")
    }
}

/// 할 일 없음 (되돌릴/다시 할 것 없음) — journal 불변.
pub fn nothing(reason: UndoReason) -> UndoOutcome {
    UndoOutcome {
        reason: Some(reason),
        message: None,
        ..bare("")
    }
}

fn ok_with_locs(source: &SourceId, refresh: HashSet<PathBuf>) -> UndoOutcome {
    ok_multi(refresh.into_iter().map(|p| (source.clone(), p)).collect())
}

fn ok_multi(refresh: HashSet<(SourceId, PathBuf)>) -> UndoOutcome {
    UndoOutcome {
        kind: UndoKind::Ok,
        message: None,
        refreshed_locations: refresh
            .into_iter()
            .map(|(source, path)| Location { source, path })
            .collect(),
        ..bare("")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::journal::{JournalEntry, JournalId, OpKind};
    use chrono::Utc;
    use tempfile::TempDir;

    fn mk_entry(undo: UndoAction) -> JournalEntry {
        JournalEntry {
            id: JournalId::new(),
            timestamp: Utc::now(),
            op: OpKind::Mkdir {
                path: PathBuf::from("/tmp"),
                source: SourceId::Local,
            },
            undo,
            undone: false,
            stale: false,
        }
    }

    #[tokio::test]
    async fn irreversible_returns_irreversible() {
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::Irreversible);
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Irreversible));
    }

    #[tokio::test]
    async fn undo_mkdir_removes_empty_dir() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new");
        tokio::fs::create_dir(&target).await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoMkdir {
            source: SourceId::Local,
            path: target.clone(),
        });
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Ok));
        assert!(!target.exists());
    }

    /// 새 파일 undo — 빈 파일만 제거, 내용이 생겼으면 손실 없이 skip. redo 는 재생성.
    #[tokio::test]
    async fn undo_new_file_removes_only_empty_then_redo_recreates() {
        let dir = TempDir::new().unwrap();
        let pool = ConnectionPool::new();

        let filled = dir.path().join("filled.txt");
        tokio::fs::write(&filled, b"typed later").await.unwrap();
        let entry = mk_entry(UndoAction::UndoNewFile {
            source: SourceId::Local,
            path: filled.clone(),
        });
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Stale));
        assert!(filled.exists(), "내용이 있는 파일은 undo 로 지우지 않는다");

        let empty = dir.path().join("empty.txt");
        tokio::fs::write(&empty, b"").await.unwrap();
        let entry = mk_entry(UndoAction::UndoNewFile {
            source: SourceId::Local,
            path: empty.clone(),
        });
        let fixture = crate::fs::testing::TestFs::new(dir.path());
        let outcome = undo_new_file(&fixture, &SourceId::Local, &empty).await;
        assert!(matches!(outcome.kind, UndoKind::Ok));
        assert!(!empty.exists());

        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Ok));
        assert!(empty.is_file());
    }

    #[tokio::test]
    async fn redo_rename_reapplies_forward() {
        let dir = TempDir::new().unwrap();
        let original = dir.path().join("a.txt");
        let current = dir.path().join("b.txt");
        // undo 직후 상태: 파일이 original 로 돌아와 있음.
        tokio::fs::write(&original, b"x").await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoRename {
            source: SourceId::Local,
            current: current.clone(),
            original: original.clone(),
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(
            matches!(outcome.kind, UndoKind::Ok),
            "{:?}",
            outcome.message
        );
        assert!(current.exists());
        assert!(!original.exists());
    }

    #[tokio::test]
    async fn redo_mkdir_recreates_and_move_with_backups_unsupported() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new");
        let pool = ConnectionPool::new();
        // mkdir redo — undo 로 지워진 폴더 재생성.
        let entry = mk_entry(UndoAction::UndoMkdir {
            source: SourceId::Local,
            path: target.clone(),
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Ok));
        assert!(target.exists());
        // 덮어쓰기(.bak) 동반 이동은 1단계 미지원 — Skipped 안내.
        let entry = mk_entry(UndoAction::UndoMove {
            src_source: SourceId::Local,
            dst_source: SourceId::Local,
            moved: vec![],
            backups_to_restore: vec![crate::services::journal::BackupRestore {
                backup_path: dir.path().join("x.bak"),
                original_path: dir.path().join("x"),
                applied: None,
            }],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
    }

    #[tokio::test]
    async fn redo_sync_recopies_pure_additive_only() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("s.txt");
        let dst = dir.path().join("dst").join("s.txt");
        tokio::fs::create_dir(dir.path().join("dst")).await.unwrap();
        tokio::fs::write(&src, b"sync").await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoSync {
            dst_source: SourceId::Local,
            created: vec![dst.clone()],
            backups_to_restore: vec![],
            pruned: vec![],
            src_source: Some(SourceId::Local),
            created_from: vec![src.clone()],
            created_stamps: vec![],
            created_dirs: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(
            matches!(outcome.kind, UndoKind::Ok),
            "{:?}",
            outcome.message
        );
        assert_eq!(tokio::fs::read(&dst).await.unwrap(), b"sync");
        // prune 동반 sync 는 미지원.
        let entry = mk_entry(UndoAction::UndoSync {
            dst_source: SourceId::Local,
            created: vec![dst.clone()],
            backups_to_restore: vec![],
            pruned: vec![crate::services::journal::TrashItem {
                trash_path: "x".into(),
                original_path: dir.path().join("gone"),
            }],
            src_source: Some(SourceId::Local),
            created_from: vec![src.clone()],
            created_stamps: vec![],
            created_dirs: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
    }

    #[tokio::test]
    async fn redo_copy_recopies_from_recorded_sources() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("a.txt");
        let dst = dir.path().join("dst").join("a.txt");
        tokio::fs::create_dir(dir.path().join("dst")).await.unwrap();
        tokio::fs::write(&src, b"data").await.unwrap();
        let pool = ConnectionPool::new();
        // undo 직후 상태: dst 는 제거됨, src 만 존재.
        let entry = mk_entry(UndoAction::UndoCopy {
            target_source: SourceId::Local,
            copied: vec![dst.clone()],
            backups_to_restore: vec![],
            src_source: Some(SourceId::Local),
            copied_from: vec![src.clone()],
            copied_stamps: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(
            matches!(outcome.kind, UndoKind::Ok),
            "{:?}",
            outcome.message
        );
        assert_eq!(tokio::fs::read(&dst).await.unwrap(), b"data");
        // src 미기록(구버전/아카이브) entry 는 미지원 안내.
        let entry = mk_entry(UndoAction::UndoCopy {
            target_source: SourceId::Local,
            copied: vec![dst.clone()],
            backups_to_restore: vec![],
            src_source: None,
            copied_from: vec![],
            copied_stamps: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
    }

    #[tokio::test]
    async fn redo_merge_recopies_pairs_and_old_format_skipped() {
        let dir = TempDir::new().unwrap();
        let left = dir.path().join("L");
        let right = dir.path().join("R");
        tokio::fs::create_dir(&left).await.unwrap();
        tokio::fs::create_dir(&right).await.unwrap();
        // undo 직후 상태: 원본만 존재 (left 의 a.txt → right 로 머지됐다가 되돌림).
        tokio::fs::write(left.join("a.txt"), b"m").await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoBidirMerge {
            left_source: SourceId::Local,
            left_created: vec![],
            right_source: SourceId::Local,
            right_created: vec![right.join("a.txt")],
            left_pairs: vec![],
            right_pairs: vec![crate::services::journal::RedoCopyPair {
                from: left.join("a.txt"),
                to: right.join("a.txt"),
            }],
            left_created_stamps: vec![],
            right_created_stamps: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(
            matches!(outcome.kind, UndoKind::Ok),
            "{:?}",
            outcome.message
        );
        assert_eq!(tokio::fs::read(right.join("a.txt")).await.unwrap(), b"m");
        // 구버전 entry(쌍 미기록) — 미지원 안내.
        let entry = mk_entry(UndoAction::UndoBidirMerge {
            left_source: SourceId::Local,
            left_created: vec![],
            right_source: SourceId::Local,
            right_created: vec![right.join("a.txt")],
            left_pairs: vec![],
            right_pairs: vec![],
            left_created_stamps: vec![],
            right_created_stamps: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
    }

    #[tokio::test]
    async fn redo_compare_apply_requires_no_backups() {
        let dir = TempDir::new().unwrap();
        let pool = ConnectionPool::new();
        // 덮어쓰기(백업) 동반 적용은 미지원.
        let entry = mk_entry(UndoAction::UndoCompareApply {
            left_source: SourceId::Local,
            right_source: SourceId::Local,
            left_created: vec![],
            right_created: vec![],
            left_backups: vec![crate::services::journal::BackupRestore {
                backup_path: dir.path().join("x.bak"),
                original_path: dir.path().join("x"),
                applied: None,
            }],
            right_backups: vec![],
            left_pairs: vec![crate::services::journal::RedoCopyPair {
                from: dir.path().join("y"),
                to: dir.path().join("x"),
            }],
            right_pairs: vec![],
            left_created_stamps: vec![],
            right_created_stamps: vec![],
        });
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
    }

    #[tokio::test]
    async fn redo_unsupported_variants_are_skipped() {
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::Irreversible);
        let outcome = execute_redo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Skipped));
    }

    #[tokio::test]
    async fn undo_mkdir_skips_when_not_empty() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new");
        tokio::fs::create_dir(&target).await.unwrap();
        tokio::fs::write(target.join("a"), b"").await.unwrap();
        let pool = ConnectionPool::new();
        let entry = mk_entry(UndoAction::UndoMkdir {
            source: SourceId::Local,
            path: target.clone(),
        });
        let outcome = execute_undo(&entry, &pool).await;
        assert!(matches!(outcome.kind, UndoKind::Stale));
        assert!(target.exists());
    }
    #[tokio::test]
    async fn undo_new_file_preserves_a_concurrent_edit_in_trash() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("empty");
        tokio::fs::write(&file, b"").await.unwrap();
        let mut fs = crate::fs::testing::TestFs::new(dir.path());
        fs.late_write = true;
        let outcome = undo_new_file(&fs, &SourceId::Local, &file).await;
        assert!(matches!(outcome.kind, UndoKind::Ok));
        assert_eq!(
            tokio::fs::read(dir.path().join("recovered")).await.unwrap(),
            b"concurrent edit"
        );
    }

    #[tokio::test]
    async fn undo_mkdir_keeps_directory_when_listing_fails() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("new");
        tokio::fs::create_dir(&target).await.unwrap();
        let mut fs = crate::fs::testing::TestFs::new(dir.path());
        fs.fail_list = true;
        let outcome = undo_new_dir(&fs, &SourceId::Local, &target).await;
        assert!(matches!(outcome.kind, UndoKind::Error));
        assert!(target.exists());
    }
}

/// fileops 점검(2026-11-08, opus) 재현 테스트 — undo 가 사용자 데이터를 잃게 하는 경로.
/// 모든 파일은 tempdir 안. 휴지통(LocalFs::trash)은 부르지 않는다.
#[cfg(test)]
mod review_fileops_opus {
    use super::*;
    use crate::core::ops::{self, ConflictPolicy, OpCtx};
    use crate::types::EntryRef;
    use tempfile::TempDir;
    use tokio_util::sync::CancellationToken;

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

    fn eref(parent: &std::path::Path, name: &str) -> EntryRef {
        EntryRef {
            location: Location {
                source: SourceId::Local,
                path: parent.to_path_buf(),
            },
            name: name.into(),
        }
    }

    fn loc(p: &std::path::Path) -> Location {
        Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        }
    }

    /// F-opus: 이름 바꾸기 후 원래 이름으로 새 파일이 생기면, Ctrl+Z 가 그 새 파일을
    /// 경고 없이 덮어쓴다(POSIX rename = 교체). redo 쪽은 같은 상황을 Skipped 로 막는다.
    #[tokio::test]
    async fn undo_rename_must_not_overwrite_file_recreated_at_original_name() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        tokio::fs::write(dir.path().join("a.txt"), b"v1")
            .await
            .unwrap();
        let entry = ops::rename(
            &LocalFs::new(),
            eref(dir.path(), "a.txt"),
            "b.txt".into(),
            &ctx,
        )
        .await
        .unwrap();
        // 사용자가 그사이 같은 이름으로 새 작업 파일을 만든다.
        tokio::fs::write(dir.path().join("a.txt"), b"new work")
            .await
            .unwrap();

        let pool = ConnectionPool::new();
        let outcome = execute_undo(&entry, &pool).await;

        let a = tokio::fs::read(dir.path().join("a.txt")).await.unwrap();
        assert_eq!(
            a, b"new work",
            "undo overwrote the new a.txt (outcome={:?}, msg={:?})",
            outcome.kind, outcome.message
        );
    }

    /// F-opus: 이동 후 원래 자리에 같은 이름 파일이 새로 생기면, Ctrl+Z 가 덮어쓴다.
    #[tokio::test]
    async fn undo_move_must_not_overwrite_file_recreated_at_source() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir(&src).await.unwrap();
        tokio::fs::create_dir(&dst).await.unwrap();
        tokio::fs::write(src.join("x.txt"), b"moved").await.unwrap();
        let fs = LocalFs::new();
        let plan = ops::move_plan(&fs, &fs, vec![eref(&src, "x.txt")], loc(&dst))
            .await
            .unwrap();
        let entry = ops::move_execute(
            &fs,
            &fs,
            plan,
            ConflictPolicy::Skip,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        tokio::fs::write(src.join("x.txt"), b"new work")
            .await
            .unwrap();

        let pool = ConnectionPool::new();
        let outcome = execute_undo(&entry, &pool).await;

        let x = tokio::fs::read(src.join("x.txt")).await.unwrap();
        assert_eq!(
            x, b"new work",
            "undo overwrote the new src/x.txt (outcome={:?}, msg={:?})",
            outcome.kind, outcome.message
        );
    }

    /// F-opus: 폴더 복사 후 사본 폴더 안에서 작업한 파일이, 복사 Ctrl+Z 로 **영구 삭제**된다
    /// (UndoCopy 는 `fs.remove` = remove_dir_all, 휴지통 아님 — CLAUDE.md §3).
    #[tokio::test]
    async fn undo_copy_must_not_permanently_delete_work_added_inside_copied_folder() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir_all(src.join("proj")).await.unwrap();
        tokio::fs::create_dir(&dst).await.unwrap();
        tokio::fs::write(src.join("proj").join("a.txt"), b"a")
            .await
            .unwrap();
        let fs = LocalFs::new();
        let plan = ops::copy_plan(&fs, &fs, vec![eref(&src, "proj")], loc(&dst))
            .await
            .unwrap();
        let entry = ops::copy_execute(
            &fs,
            &fs,
            plan,
            ConflictPolicy::Skip,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        // 사용자가 사본 폴더 안에서 새 작업을 한다(journal 에 안 남는 일반 편집).
        let notes = dst.join("proj").join("notes.txt");
        tokio::fs::write(&notes, b"hours of work").await.unwrap();

        let pool = ConnectionPool::new();
        let outcome = execute_undo(&entry, &pool).await;

        assert!(
            notes.exists(),
            "undo copy permanently deleted user work inside the copied folder \
             (outcome={:?}, msg={:?})",
            outcome.kind,
            outcome.message
        );
        // 바뀐 사본은 건너뛰고(휴지통도 부르지 않음) 이유를 알린다.
        assert_eq!(outcome.kind, UndoKind::Stale);
        assert_eq!(outcome.reason, Some(UndoReason::Changed));
    }

    /// F-opus: 파일을 Replace 로 덮어쓴 복사를 Ctrl+Z 하면, 옛 버전은 (설계상) 이미 없고
    /// 새 버전까지 지워져 받는 위치에 아무것도 안 남는데 결과는 Ok(성공 토스트)로 보고된다.
    #[tokio::test]
    #[ignore = "fileops-21 repro"]
    async fn undo_copy_after_file_replace_reports_ok_but_leaves_nothing() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir(&src).await.unwrap();
        tokio::fs::create_dir(&dst).await.unwrap();
        tokio::fs::write(src.join("r.txt"), b"new").await.unwrap();
        tokio::fs::write(dst.join("r.txt"), b"old").await.unwrap();
        let fs = LocalFs::new();
        let plan = ops::copy_plan(&fs, &fs, vec![eref(&src, "r.txt")], loc(&dst))
            .await
            .unwrap();
        assert_eq!(plan.conflicts.len(), 1);
        let entry = ops::copy_execute(
            &fs,
            &fs,
            plan,
            ConflictPolicy::Replace,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        let pool = ConnectionPool::new();
        let outcome = execute_undo(&entry, &pool).await;

        let left = dst.join("r.txt").exists();
        assert!(
            left || !matches!(outcome.kind, UndoKind::Ok),
            "undo reported Ok but dst/r.txt is gone entirely (old version was \
             permanently replaced, new version now deleted)"
        );
    }

    /// F-opus: 여러 항목 이동의 undo 중 한 항목이 사라졌으면, 앞 항목은 이미 되돌린 뒤
    /// "undo skipped" 로 보고하고 entry 는 undone 처리 안 됨 → 다음 Ctrl+Z 도 같은 entry 에서
    /// 영원히 Skipped (그 이전 작업들은 Ctrl+Z 로 닿을 수 없다).
    #[tokio::test]
    async fn undo_move_partial_skip_must_not_half_apply_and_report_skipped() {
        let (ctx, _keep) = mk_ctx().await;
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("src");
        let dst = dir.path().join("dst");
        tokio::fs::create_dir(&src).await.unwrap();
        tokio::fs::create_dir(&dst).await.unwrap();
        tokio::fs::write(src.join("a.txt"), b"a").await.unwrap();
        tokio::fs::write(src.join("b.txt"), b"b").await.unwrap();
        let fs = LocalFs::new();
        let plan = ops::move_plan(
            &fs,
            &fs,
            vec![eref(&src, "a.txt"), eref(&src, "b.txt")],
            loc(&dst),
        )
        .await
        .unwrap();
        let entry = ops::move_execute(
            &fs,
            &fs,
            plan,
            ConflictPolicy::Skip,
            &ctx,
            CancellationToken::new(),
            None,
        )
        .await
        .unwrap();
        // 사용자가 옮겨진 b.txt 를 다른 곳으로 치움 (여기선 다른 폴더로 rename).
        tokio::fs::rename(dst.join("b.txt"), dir.path().join("b-elsewhere.txt"))
            .await
            .unwrap();

        let pool = ConnectionPool::new();
        let first = execute_undo(&entry, &pool).await;
        let a_back = src.join("a.txt").exists();
        // 두 번째 Ctrl+Z (journal 은 Skipped 를 undone 처리하지 않으므로 같은 entry).
        let second = execute_undo(&entry, &pool).await;

        eprintln!(
            "first={:?} {:?} a_back={a_back} second={:?} {:?}",
            first.kind, first.message, second.kind, second.message
        );
        assert!(
            !(a_back && matches!(first.kind, UndoKind::Skipped)),
            "undo moved a.txt back but reported the whole undo as skipped"
        );
        // 고친 뒤: 되돌린 만큼은 Partial 로 보고하고, 빠진 항목은 사유와 함께 남긴다.
        assert!(a_back);
        assert_eq!(first.kind, UndoKind::Partial);
        assert_eq!(first.skipped.len(), 1);
        assert_eq!(first.skipped[0].reason, UndoReason::Gone);
        assert_eq!(first.skipped[0].path, dst.join("b.txt"));
    }

    /// U-10: 대소문자만 바꾼 이름 바꾸기의 undo 는 자기 자신을 "점유"로 오판하지 않는다.
    #[tokio::test]
    async fn undo_case_only_rename_is_not_blocked_by_itself() {
        let dir = TempDir::new().unwrap();
        let upper = dir.path().join("A.txt");
        tokio::fs::write(&upper, b"x").await.unwrap();
        if !dir.path().join("a.txt").exists() {
            eprintln!("SKIP: case-sensitive volume");
            return;
        }
        let entry = JournalEntry {
            id: crate::services::journal::JournalId::new(),
            timestamp: chrono::Utc::now(),
            op: crate::services::journal::OpKind::Rename {
                from: dir.path().join("a.txt"),
                to: upper.clone(),
                source: SourceId::Local,
            },
            undo: UndoAction::UndoRename {
                source: SourceId::Local,
                current: upper,
                original: dir.path().join("a.txt"),
            },
            undone: false,
            stale: false,
        };
        let out = execute_undo(&entry, &ConnectionPool::new()).await;
        assert_eq!(out.kind, UndoKind::Ok, "{out:?}");
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["a.txt".to_string()]);
    }

    /// U-10: 새 파일이 생긴 이름은 건너뛰되 나머지 batch 항목은 되돌린다.
    #[tokio::test]
    async fn batch_undo_skips_only_the_occupied_pair() {
        let dir = TempDir::new().unwrap();
        let d = dir.path();
        for (n, c) in [("x2", "x"), ("y2", "y"), ("x", "new work")] {
            tokio::fs::write(d.join(n), c).await.unwrap();
        }
        let entry = JournalEntry {
            id: crate::services::journal::JournalId::new(),
            timestamp: chrono::Utc::now(),
            op: crate::services::journal::OpKind::BatchRename {
                count: 2,
                location: loc(d),
            },
            undo: UndoAction::UndoBatchRename {
                source: SourceId::Local,
                pairs: vec![
                    crate::services::journal::RenamePair {
                        current: d.join("x2"),
                        original: d.join("x"),
                    },
                    crate::services::journal::RenamePair {
                        current: d.join("y2"),
                        original: d.join("y"),
                    },
                ],
            },
            undone: false,
            stale: false,
        };
        let out = execute_undo(&entry, &ConnectionPool::new()).await;
        assert_eq!(out.kind, UndoKind::Partial, "{out:?}");
        assert_eq!(out.skipped[0].reason, UndoReason::Occupied);
        assert_eq!(std::fs::read(d.join("x")).unwrap(), b"new work");
        assert_eq!(std::fs::read(d.join("x2")).unwrap(), b"x");
        assert_eq!(std::fs::read(d.join("y")).unwrap(), b"y");
    }

    /// F-opus: macOS 로컬 휴지통 삭제의 undo 는 NotSupported → UndoKind::Error.
    /// `undo_last` 는 Error 를 undone 처리하지 않으므로(commands/undo.rs) 이후 Ctrl+Z 는
    /// 영원히 이 entry 에서 같은 오류 — 그 이전 작업들은 되돌릴 수 없게 된다.
    /// (LocalFs::restore_many 는 macOS 에서 아무것도 건드리지 않고 거부만 한다 — 안전.)
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_trash_undo_is_error_and_would_block_the_undo_stack() {
        let pool = ConnectionPool::new();
        let entry = JournalEntry {
            id: crate::services::journal::JournalId::new(),
            timestamp: chrono::Utc::now(),
            op: crate::services::journal::OpKind::Trash {
                count: 1,
                location: loc(std::path::Path::new("/tmp/never-touched")),
            },
            undo: UndoAction::RestoreFromTrash {
                source: SourceId::Local,
                items: vec![crate::services::journal::TrashItem {
                    trash_path: String::new(),
                    original_path: PathBuf::from("/tmp/never-touched/x.txt"),
                }],
            },
            undone: false,
            stale: false,
        };
        let outcome = execute_undo(&entry, &pool).await;
        eprintln!(
            "macOS trash undo -> {:?} {:?}",
            outcome.kind, outcome.message
        );
        // 기대: 되돌릴 수 없으면 Irreversible/Skipped 로 종결돼 다음 Ctrl+Z 가 이전 작업으로
        // 넘어가야 한다. Error 는 entry 를 그대로 남긴다.
        assert!(
            !matches!(outcome.kind, UndoKind::Error),
            "macOS trash undo returns Error -> entry never marked undone -> undo stack stuck: {:?}",
            outcome.message
        );
    }
}

#[cfg(test)]
mod review_fileops_sol_r3 {
    use super::*;
    use crate::services::journal::{BackupRestore, Journal, OpKind};

    struct Fixture {
        _temp: tempfile::TempDir,
        journal: Arc<Journal>,
        entry: JournalEntry,
        originals: [PathBuf; 2],
        backups: [PathBuf; 2],
    }

    async fn fixture(occupied: bool) -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let dst = temp.path().join("dst");
        tokio::fs::create_dir(&dst).await.unwrap();
        let originals = [dst.join("first"), dst.join("second")];
        let backups = [dst.join("first.bak"), dst.join("second.bak")];
        for (index, backup) in backups.iter().enumerate() {
            tokio::fs::create_dir(backup).await.unwrap();
            tokio::fs::write(backup.join("old.txt"), format!("original-{index}"))
                .await
                .unwrap();
        }
        if occupied {
            tokio::fs::create_dir(&originals[0]).await.unwrap();
            tokio::fs::write(originals[0].join("partial.txt"), b"partial new copy")
                .await
                .unwrap();
        }
        let journal = Journal::load_from(&temp.path().join("journal.jsonl"))
            .await
            .unwrap();
        let entry = journal
            .push(
                OpKind::Copy {
                    count: 0,
                    src: Location {
                        source: SourceId::Local,
                        path: temp.path().join("src"),
                    },
                    dst: Location {
                        source: SourceId::Local,
                        path: dst,
                    },
                },
                UndoAction::UndoCopy {
                    target_source: SourceId::Local,
                    copied: vec![],
                    backups_to_restore: (0..2)
                        .map(|i| BackupRestore {
                            backup_path: backups[i].clone(),
                            original_path: originals[i].clone(),
                            applied: None,
                        })
                        .collect(),
                    src_source: Some(SourceId::Local),
                    copied_from: vec![],
                    copied_stamps: vec![],
                },
            )
            .await
            .unwrap();
        Fixture {
            _temp: temp,
            journal,
            entry,
            originals,
            backups,
        }
    }

    #[tokio::test]
    #[ignore = "fileops-15 repro"]
    async fn partial_first_folder_must_not_block_second_backup_restore() {
        let f = fixture(true).await;
        let outcome = execute_undo(&f.entry, &ConnectionPool::new()).await;
        let next = f.journal.peek_undoable().await.unwrap().unwrap();
        eprintln!(
            "R3 occupied-first outcome={outcome:?}; first_partial={} first_backup={} second_restored={} second_backup={} same_undo_entry={} undone={}",
            f.originals[0].join("partial.txt").exists(), f.backups[0].join("old.txt").exists(),
            f.originals[1].join("old.txt").exists(), f.backups[1].join("old.txt").exists(),
            next.id == f.entry.id, next.undone,
        );
        assert!(
            f.originals[1].join("old.txt").exists(),
            "first occupied partial folder prevents restoring the independent second backup; outcome={outcome:?}"
        );
    }

    #[tokio::test]
    async fn both_backups_restore_when_original_locations_are_free() {
        let f = fixture(false).await;
        let outcome = execute_undo(&f.entry, &ConnectionPool::new()).await;
        assert!(matches!(outcome.kind, UndoKind::Ok), "{outcome:?}");
        for i in 0..2 {
            assert_eq!(
                tokio::fs::read(f.originals[i].join("old.txt"))
                    .await
                    .unwrap(),
                format!("original-{i}").as_bytes()
            );
            assert!(!f.backups[i].exists());
        }
    }
}
