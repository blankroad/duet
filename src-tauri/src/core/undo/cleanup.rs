//! 생성분 정리 undo — 복사·동기화·병합·비교 적용·3-way (G-01 / U-02).
//!
//! 이 작업들의 Ctrl+Z 는 "새로 만든 것 치우기 + 덮어쓴 자리 되돌리기" 다. 안전 규칙:
//! - 치우는 것은 **기록 때 지문(`ItemStamp`)과 지금이 같을 때만**, 그리고 **휴지통으로**
//!   (원격은 `~/.duet-trash`). 그 사이 사용자가 고친·추가한 내용이 있으면 건너뛰고 알린다.
//! - 지문이 없는 구버전 기록은 바뀌었는지 알 수 없으니 건너뛴다(`Unverifiable`).
//! - 덮어쓴 자리는 지금 내용이 적용 직후 지문과 같을 때만 휴지통으로 보낸 뒤 백업을
//!   덮어쓰지 않고(`rename_no_replace`) 되돌린다. 다르면 백업은 그대로 두고 위치를 알린다.
//! - 연결·휴지통 오류는 `Error` 로 돌려 재시도할 수 있게 한다(삼키지 않음). 재시도 때
//!   이미 치운 항목은 "없음" 으로 걸러진다.
//!
//! 파일시스템은 `FsResolver` 로 얻는다 — 실제는 연결 풀, 테스트는 OS 휴지통을 부르지 않는
//! fixture 를 넣는다.

use super::{error, restore_backup, Step, Tally, UndoOutcome, UndoReason};
use crate::core::stamp;
use crate::fs::FileSystem;
use crate::services::connection_pool::ConnectionPool;
use crate::services::journal::{BackupRestore, ItemStamp, JournalEntry, TrashItem, UndoAction};
use crate::types::{DuetError, SourceId, TrashLocation};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// undo 가 source 별 파일시스템을 얻는 방법.
#[async_trait]
pub trait FsResolver: Send + Sync {
    async fn fs(&self, source: &SourceId) -> Result<Box<dyn FileSystem>, DuetError>;
}

/// 실제 실행용 — 로컬은 `LocalFs`, 원격은 연결 풀의 세션.
pub struct PoolFs<'a>(pub &'a Arc<ConnectionPool>);

#[async_trait]
impl FsResolver for PoolFs<'_> {
    async fn fs(&self, source: &SourceId) -> Result<Box<dyn FileSystem>, DuetError> {
        super::fs_for(source, self.0).await
    }
}

/// 생성분 정리 계열(UndoCopy·UndoSync·UndoBidirMerge·UndoCompareApply·UndoThreeWayApply)을
/// 되돌린다. 그 외 종류는 `None` (호출자가 `execute_undo` 로 처리).
pub async fn undo_cleanup(entry: &JournalEntry, r: &dyn FsResolver) -> Option<UndoOutcome> {
    let sides: Vec<Side<'_>> = match &entry.undo {
        UndoAction::UndoCopy {
            target_source,
            copied,
            backups_to_restore,
            copied_stamps,
            ..
        } => vec![Side {
            backups: backups_to_restore,
            // 폴더 교체 백업 — 그 자리는 생성분 지문이 덮는다. 아직 차 있으면 점유.
            unknown_applied: UndoReason::Occupied,
            ..Side::new(target_source, copied, copied_stamps)
        }],
        UndoAction::UndoSync {
            dst_source,
            created,
            backups_to_restore,
            pruned,
            created_stamps,
            created_dirs,
            ..
        } => vec![Side {
            backups: backups_to_restore,
            created_dirs,
            trashed: pruned,
            ..Side::new(dst_source, created, created_stamps)
        }],
        UndoAction::UndoBidirMerge {
            left_source,
            left_created,
            right_source,
            right_created,
            left_created_stamps,
            right_created_stamps,
            ..
        } => vec![
            Side::new(left_source, left_created, left_created_stamps),
            Side::new(right_source, right_created, right_created_stamps),
        ],
        UndoAction::UndoCompareApply {
            left_source,
            right_source,
            left_created,
            right_created,
            left_backups,
            right_backups,
            left_created_stamps,
            right_created_stamps,
            ..
        } => vec![
            Side {
                backups: left_backups,
                ..Side::new(left_source, left_created, left_created_stamps)
            },
            Side {
                backups: right_backups,
                ..Side::new(right_source, right_created, right_created_stamps)
            },
        ],
        UndoAction::UndoThreeWayApply {
            left_source,
            right_source,
            left_created,
            right_created,
            left_backups,
            right_backups,
            trashed_left,
            trashed_right,
            left_created_stamps,
            right_created_stamps,
        } => vec![
            Side {
                backups: left_backups,
                trashed: trashed_left,
                ..Side::new(left_source, left_created, left_created_stamps)
            },
            Side {
                backups: right_backups,
                trashed: trashed_right,
                ..Side::new(right_source, right_created, right_created_stamps)
            },
        ],
        _ => return None,
    };
    Some(run_sides(r, &sides).await)
}

/// 한쪽(받는 쪽) 정리 대상.
struct Side<'a> {
    source: &'a SourceId,
    created: &'a [PathBuf],
    stamps: &'a [Option<ItemStamp>],
    backups: &'a [BackupRestore],
    /// 덮어쓴 자리에 무언가 있는데 적용 직후 지문이 없을 때의 사유.
    unknown_applied: UndoReason,
    /// 이 작업이 새로 만든 폴더(부모 먼저) — 비었을 때만 제거.
    created_dirs: &'a [PathBuf],
    /// 이 작업이 휴지통으로 보낸 항목 — 복원.
    trashed: &'a [TrashItem],
}

impl<'a> Side<'a> {
    fn new(source: &'a SourceId, created: &'a [PathBuf], stamps: &'a [Option<ItemStamp>]) -> Self {
        Side {
            source,
            created,
            stamps,
            backups: &[],
            unknown_applied: UndoReason::Unverifiable,
            created_dirs: &[],
            trashed: &[],
        }
    }

    /// `created[i]` 의 기록 지문. 병렬 배열 길이가 어긋나면(손상·구버전) 전부 확인 불가.
    fn stamp_at(&self, i: usize) -> Option<&'a ItemStamp> {
        if self.stamps.len() != self.created.len() {
            return None;
        }
        self.stamps.get(i).and_then(Option::as_ref)
    }
}

/// 모든 쪽의 fs 를 **먼저** 얻고(한쪽만 처리하고 "되돌림"으로 끝나는 일 방지 — SC-09),
/// 쪽마다 생성분 → 만든 폴더 → 덮어쓴 자리 → 휴지통 복원 순으로 처리한다.
/// undo 한 번은 휴지통 batch 하나를 쓴다.
async fn run_sides(r: &dyn FsResolver, sides: &[Side<'_>]) -> UndoOutcome {
    let mut fss = Vec::with_capacity(sides.len());
    for side in sides {
        match r.fs(side.source).await {
            Ok(fs) => fss.push(fs),
            Err(e) => return error("source unreachable", e),
        }
    }
    let batch = crate::services::trash::new_batch_id();
    let mut t = Tally::default();
    for (side, fs) in sides.iter().zip(&fss) {
        if let Err(e) = run_side(&mut t, &**fs, side, &batch).await {
            return t.fail("undo", e);
        }
    }
    t.finish()
}

async fn run_side(
    t: &mut Tally,
    fs: &dyn FileSystem,
    side: &Side<'_>,
    batch: &str,
) -> Result<(), DuetError> {
    for (i, p) in side.created.iter().enumerate() {
        let step = trash_if_unchanged(fs, p, side.stamp_at(i), batch).await?;
        t.record(step, side.source, p);
    }
    remove_created_dirs(t, fs, side.source, side.created_dirs).await?;
    for b in side.backups {
        match restore_overwritten(fs, b, side.unknown_applied, batch).await? {
            None => {}
            Some(Step::Done) => t.record(Step::Done, side.source, &b.original_path),
            Some(step) => {
                t.record(step, side.source, &b.original_path);
                t.note(format!(
                    "{} was kept as {}",
                    b.original_path.display(),
                    b.backup_path.display()
                ));
            }
        }
    }
    restore_trashed(t, fs, side.source, side.trashed).await
}

/// 생성분 하나: 없음 → 할 일 없음, 지문 없음 → 건너뜀(확인 불가), 지문 다름 → 건너뜀(바뀜),
/// 같음 → 휴지통. 휴지통·확인 오류는 `Err`.
pub(crate) async fn trash_if_unchanged(
    fs: &dyn FileSystem,
    path: &Path,
    recorded: Option<&ItemStamp>,
    batch: &str,
) -> Result<Step, DuetError> {
    match fs.symlink_metadata(path).await {
        Ok(_) => {}
        Err(DuetError::NotFound(_)) => return Ok(Step::Done),
        Err(e) => return Err(e),
    }
    let Some(recorded) = recorded else {
        return Ok(Step::Skip(UndoReason::Unverifiable));
    };
    let now = stamp::stamp(fs, path).await?;
    if !stamp::same(recorded, &now) {
        return Ok(Step::Skip(UndoReason::Changed));
    }
    fs.trash(path, batch).await?;
    Ok(Step::Done)
}

/// 덮어쓴 자리 되돌리기. 백업이 이미 없으면 `None`(복원할 것 없음).
///
/// 지금 자리가 비어 있으면 바로 복원, 차 있으면 적용 직후 지문과 같을 때만 휴지통으로
/// 보낸 뒤 복원. 지문이 없으면 `unknown` 사유, 다르면 `Changed` 로 건너뛰고 백업은 둔다.
async fn restore_overwritten(
    fs: &dyn FileSystem,
    b: &BackupRestore,
    unknown: UndoReason,
    batch: &str,
) -> Result<Option<Step>, DuetError> {
    match fs.symlink_metadata(&b.backup_path).await {
        Ok(_) => {}
        Err(DuetError::NotFound(_)) => return Ok(None),
        Err(e) => return Err(e),
    }
    match fs.symlink_metadata(&b.original_path).await {
        Err(DuetError::NotFound(_)) => {}
        Err(e) => return Err(e),
        Ok(_) => {
            let Some(applied) = b.applied.as_ref() else {
                return Ok(Some(Step::Skip(unknown)));
            };
            let now = stamp::stamp(fs, &b.original_path).await?;
            if !stamp::same(applied, &now) {
                return Ok(Some(Step::Skip(UndoReason::Changed)));
            }
            fs.trash(&b.original_path, batch).await?;
        }
    }
    restore_backup(fs, &b.backup_path, &b.original_path).await
}

/// 동기화가 만든 폴더를 깊은 것부터, 비어 있을 때만 지운다(SC-31). 이미 없거나 안 비었으면
/// 조용히 둔다(그 안에 남은 항목은 이미 건너뜀으로 보고됨). 빈 폴더인데 못 지운 경우
/// (권한·연결·I/O)는 `Err` — 재시도할 수 있게 확정하지 않는다.
async fn remove_created_dirs(
    t: &mut Tally,
    fs: &dyn FileSystem,
    source: &SourceId,
    dirs: &[PathBuf],
) -> Result<(), DuetError> {
    for d in dirs.iter().rev() {
        let err = match fs.remove_empty_dir(d).await {
            Ok(()) => {
                t.refresh_parent(source, d);
                continue;
            }
            Err(DuetError::NotFound(_)) => continue,
            // 이 fs 가 빈 폴더 제거를 못 함 — 예전처럼 폴더를 남긴다.
            Err(DuetError::NotSupported(_)) => continue,
            Err(e) => e,
        };
        // "비어 있지 않음"은 fs 마다 오류 종류가 달라(로컬은 일반 Io) 다시 나열해 판정한다.
        match fs.list(d).await {
            Ok(children) if !children.is_empty() => {}
            Err(DuetError::NotFound(_)) => {}
            Ok(_) => return Err(err),
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// 휴지통으로 보냈던 항목 복원(prune·3-way 삭제 전파). 자리가 차 있으면 건너뜀(점유),
/// 이 OS 가 복원을 못 하면 건너뜀 + Finder 안내. 그 외 오류는 `Err`(재시도).
async fn restore_trashed(
    t: &mut Tally,
    fs: &dyn FileSystem,
    source: &SourceId,
    items: &[TrashItem],
) -> Result<(), DuetError> {
    let mut manual = false;
    for item in items {
        match fs.symlink_metadata(&item.original_path).await {
            Ok(_) => {
                t.skip(&item.original_path, UndoReason::Occupied);
                continue;
            }
            Err(DuetError::NotFound(_)) => {}
            Err(e) => return Err(e),
        }
        let loc = match source {
            SourceId::Local => TrashLocation::Local {
                trash_id: item.trash_path.clone(),
            },
            SourceId::Ssh { .. } => TrashLocation::Remote {
                trash_path: PathBuf::from(&item.trash_path),
            },
        };
        match fs.restore_from_trash(&loc, &item.original_path).await {
            Ok(()) => t.record(Step::Done, source, &item.original_path),
            Err(DuetError::NotSupported(_)) => {
                t.skip(&item.original_path, UndoReason::TrashRestoreUnsupported);
                manual = true;
            }
            Err(e) => {
                if trash_item_gone(fs, &loc, &item.original_path, &e).await? {
                    // 휴지통을 비운 등 — 다시 해도 복원할 것이 없다(스택을 막지 않음).
                    t.skip(&item.original_path, UndoReason::Gone);
                } else {
                    return Err(e);
                }
            }
        }
    }
    if manual {
        t.note("Some deleted items must be restored from the Trash manually (Finder).");
    }
    Ok(())
}

/// 휴지통 복원 실패가 "휴지통 쪽 항목이 영구히 없어짐" 때문인지 확인한다(그 외는 일시 오류).
///
/// - 원격: 휴지통 경로를 직접 lstat — 없음이면 true.
/// - 로컬: 복원이 NotFound 를 냈고 원래 부모 폴더가 있으면(= 도착지 문제가 아님) true.
///   OS 휴지통 crate 경로(Windows/Linux)는 "목록에 없음"을 일반 Io 문자열로만 알려 구분할 수
///   없어 false(Error 유지) — `fs/local.rs` 쪽 오류 종류가 정리되면 여기서 함께 처리한다.
async fn trash_item_gone(
    fs: &dyn FileSystem,
    loc: &TrashLocation,
    original: &Path,
    err: &DuetError,
) -> Result<bool, DuetError> {
    match loc {
        TrashLocation::Remote { trash_path } => match fs.symlink_metadata(trash_path).await {
            Ok(_) => Ok(false),
            Err(DuetError::NotFound(_)) => Ok(true),
            Err(e) => Err(e),
        },
        TrashLocation::Local { .. } => {
            if !matches!(err, DuetError::NotFound(_)) {
                return Ok(false);
            }
            let Some(parent) = original.parent() else {
                return Ok(false);
            };
            match fs.symlink_metadata(parent).await {
                Ok(_) => Ok(true),
                Err(DuetError::NotFound(_)) => Ok(false),
                Err(e) => Err(e),
            }
        }
    }
}

/// 테스트용 — OS 휴지통 대신 임시 폴더 안의 `trash_dir` 로 옮기는 fs 와 그 resolver.
/// 영구 삭제(`remove`)는 부르면 panic.
#[cfg(test)]
pub(crate) mod testing {
    use super::FsResolver;
    use crate::fs::{FileSystem, LocalFs};
    use crate::types::{DuetError, Entry, EntryMeta, SourceId, TrashLocation};
    use async_trait::async_trait;
    use std::path::{Path, PathBuf};
    use std::pin::Pin;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    #[derive(Clone)]
    pub(crate) struct TrashDirFs {
        pub trash_dir: PathBuf,
        n: Arc<AtomicUsize>,
        /// true 면 trash 가 실패한다 (오류를 삼키지 않는지 확인용).
        pub fail_trash: Arc<AtomicBool>,
        /// true 면 restore_from_trash 가 NotSupported (macOS 흉내).
        pub restore_unsupported: Arc<AtomicBool>,
        /// 이 경로의 remove_empty_dir 는 권한 오류 (일시 오류 전파 확인용).
        pub fail_rmdir: Arc<std::sync::Mutex<Option<PathBuf>>>,
    }

    impl TrashDirFs {
        pub(crate) fn new(trash_dir: &Path) -> Self {
            std::fs::create_dir_all(trash_dir).unwrap();
            Self {
                trash_dir: trash_dir.to_path_buf(),
                n: Arc::default(),
                fail_trash: Arc::default(),
                restore_unsupported: Arc::default(),
                fail_rmdir: Arc::default(),
            }
        }

        /// 휴지통 폴더에 들어간 항목 수.
        pub(crate) fn trashed(&self) -> usize {
            std::fs::read_dir(&self.trash_dir).unwrap().count()
        }
    }

    #[async_trait]
    impl FileSystem for TrashDirFs {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
            LocalFs.list(p).await
        }
        async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
            LocalFs.metadata(p).await
        }
        async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
            LocalFs.rename(f, t).await
        }
        async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
            LocalFs.mkdir(p).await
        }
        async fn remove_empty_dir(&self, p: &Path) -> Result<(), DuetError> {
            let blocked = self.fail_rmdir.lock().ok().and_then(|g| g.clone());
            if blocked.as_deref() == Some(p) {
                return Err(DuetError::PermissionDenied("fixture rmdir refused".into()));
            }
            LocalFs.remove_empty_dir(p).await
        }
        async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
            if self.fail_trash.load(Ordering::SeqCst) {
                return Err(DuetError::PermissionDenied("fixture trash refused".into()));
            }
            let i = self.n.fetch_add(1, Ordering::SeqCst);
            let name = p.file_name().map(|n| n.to_string_lossy().into_owned());
            let dest = self
                .trash_dir
                .join(format!("{i}-{}", name.unwrap_or_default()));
            LocalFs.rename(p, &dest).await?;
            Ok(TrashLocation::Local {
                trash_id: dest.to_string_lossy().into_owned(),
            })
        }
        async fn remove(&self, p: &Path) -> Result<(), DuetError> {
            panic!("permanent removal forbidden: {}", p.display())
        }
        async fn restore_from_trash(
            &self,
            loc: &TrashLocation,
            original: &Path,
        ) -> Result<(), DuetError> {
            if self.restore_unsupported.load(Ordering::SeqCst) {
                return Err(DuetError::NotSupported("fixture: manual restore".into()));
            }
            let TrashLocation::Local { trash_id } = loc else {
                return Err(DuetError::NotSupported("fixture is local".into()));
            };
            LocalFs.rename(Path::new(trash_id), original).await
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
            p: &Path,
            o: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            LocalFs.open_write(p, o).await
        }
    }

    /// 생성분 정리 계열 entry 를 임시 폴더 휴지통으로 되돌린다 (OS 휴지통을 부르지 않는 테스트용).
    pub(crate) async fn undo_with_fixture(
        entry: &crate::services::journal::JournalEntry,
    ) -> crate::core::undo::UndoOutcome {
        let dir = tempfile::tempdir().unwrap();
        let fs = TrashDirFs::new(&dir.path().join("trash"));
        super::undo_cleanup(entry, &FixtureResolver(fs))
            .await
            .expect("cleanup-kind entry")
    }

    /// 로컬은 fixture, 원격은 연결 끊김.
    pub(crate) struct FixtureResolver(pub TrashDirFs);

    #[async_trait]
    impl FsResolver for FixtureResolver {
        async fn fs(&self, source: &SourceId) -> Result<Box<dyn FileSystem>, DuetError> {
            match source {
                SourceId::Local => Ok(Box::new(self.0.clone())),
                SourceId::Ssh { connection_id, .. } => Err(DuetError::ConnectionFailed(format!(
                    "fixture: no connection {}",
                    connection_id.0
                ))),
            }
        }
    }
}

#[cfg(test)]
#[path = "cleanup_tests.rs"]
mod tests;
