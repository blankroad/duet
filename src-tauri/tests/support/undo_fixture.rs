//! 통합 테스트 공용 — 생성분 정리 undo 를 OS 휴지통 대신 임시 폴더 휴지통으로 실행.
//! (`#[path = "support/undo_fixture.rs"] mod undo_fixture;` 로 포함)

use async_trait::async_trait;
use duet_lib::core::undo::{undo_cleanup, FsResolver, UndoOutcome};
use duet_lib::fs::{FileSystem, LocalFs};
use duet_lib::services::journal::JournalEntry;
use duet_lib::types::{DuetError, Entry, EntryMeta, SourceId, TrashLocation};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// 휴지통 = `trash_dir` 로 rename. 영구 삭제는 panic, 휴지통 복원은 되돌려 놓기.
#[derive(Clone)]
pub struct TrashDirFs {
    pub trash_dir: PathBuf,
    n: Arc<AtomicUsize>,
}

impl TrashDirFs {
    pub fn new(trash_dir: &Path) -> Self {
        std::fs::create_dir_all(trash_dir).unwrap();
        Self {
            trash_dir: trash_dir.to_path_buf(),
            n: Arc::default(),
        }
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
        LocalFs.remove_empty_dir(p).await
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        let i = self.n.fetch_add(1, Ordering::SeqCst);
        let dest = self.trash_dir.join(i.to_string());
        LocalFs.rename(p, &dest).await?;
        Ok(TrashLocation::Local {
            trash_id: dest.to_string_lossy().into_owned(),
        })
    }
    async fn remove(&self, p: &Path) -> Result<(), DuetError> {
        panic!("permanent removal forbidden: {}", p.display())
    }
    async fn restore_from_trash(&self, loc: &TrashLocation, orig: &Path) -> Result<(), DuetError> {
        let TrashLocation::Local { trash_id } = loc else {
            return Err(DuetError::NotSupported("fixture is local".into()));
        };
        LocalFs.rename(Path::new(trash_id), orig).await
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

struct Resolver(TrashDirFs);

#[async_trait]
impl FsResolver for Resolver {
    async fn fs(&self, source: &SourceId) -> Result<Box<dyn FileSystem>, DuetError> {
        match source {
            SourceId::Local => Ok(Box::new(self.0.clone())),
            SourceId::Ssh { .. } => Err(DuetError::ConnectionFailed("fixture: no ssh".into())),
        }
    }
}

/// `entry`(복사·동기화·병합·비교 적용·3-way)를 새 임시 폴더 휴지통으로 되돌린다.
pub async fn undo_tmp(entry: &JournalEntry) -> UndoOutcome {
    let dir = tempfile::tempdir().unwrap();
    undo_cleanup(entry, &Resolver(TrashDirFs::new(&dir.path().join("trash"))))
        .await
        .expect("cleanup-kind entry")
}
