//! Temp-directory filesystem fixture: trash stays inside the fixture, never in OS trash.

use super::{FileSystem, LocalFs};
use crate::types::{DuetError, Entry, EntryMeta, SourceId, TrashLocation};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub(crate) struct TestFs {
    pub root: PathBuf,
    pub cancel_after_trash: Option<CancellationToken>,
    pub late_write: bool,
    pub fail_list: bool,
    pub override_join: bool,
}

impl TestFs {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            cancel_after_trash: None,
            late_write: false,
            fail_list: false,
            override_join: false,
        }
    }
}

#[async_trait]
impl FileSystem for TestFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    fn join(&self, base: &Path, name: &str) -> PathBuf {
        if self.override_join {
            self.root.join(name)
        } else {
            base.join(name)
        }
    }
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        if self.fail_list {
            return Err(DuetError::PermissionDenied("fixture".into()));
        }
        LocalFs.list(path).await
    }
    async fn metadata(&self, path: &Path) -> Result<EntryMeta, DuetError> {
        LocalFs.metadata(path).await
    }
    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
        LocalFs.rename(from, to).await
    }
    async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
        LocalFs.mkdir(path).await
    }
    async fn create_new_file(&self, path: &Path) -> Result<(), DuetError> {
        LocalFs.create_new_file(path).await
    }
    async fn remove_empty_dir(&self, path: &Path) -> Result<(), DuetError> {
        LocalFs.remove_empty_dir(path).await
    }
    async fn trash(&self, path: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        if self.late_write {
            tokio::fs::write(path, b"concurrent edit").await?;
        }
        let target = self.root.join("recovered");
        LocalFs.rename(path, &target).await?;
        if let Some(cancel) = &self.cancel_after_trash {
            cancel.cancel();
        }
        Ok(TrashLocation::Local {
            trash_id: target.to_string_lossy().into_owned(),
        })
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("fixture must not permanently delete")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        Err(DuetError::NotSupported("fixture".into()))
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
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        LocalFs.open_read(path, offset).await
    }
    async fn open_write(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        LocalFs.open_write(path, offset).await
    }
}
