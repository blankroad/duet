//! 로컬 파일시스템 구현.

use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, SourceId};
use async_trait::async_trait;
use std::path::Path;

/// 로컬 파일시스템 접근 구현체.
pub struct LocalFs;

impl LocalFs {
    /// 새 `LocalFs` 인스턴스를 생성한다.
    pub fn new() -> Self {
        Self
    }
}

impl Default for LocalFs {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FileSystem for LocalFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }

    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError> {
        let m = tokio::fs::symlink_metadata(path)
            .await
            .map_err(DuetError::from)?;
        let kind = if m.is_dir() {
            EntryKind::Dir
        } else if m.is_file() {
            EntryKind::File
        } else if m.file_type().is_symlink() {
            EntryKind::Symlink
        } else {
            EntryKind::Other
        };
        let size = if m.is_file() { Some(m.len()) } else { None };
        let modified_ms = m
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            Some(m.permissions().mode() & 0o777)
        };
        #[cfg(not(unix))]
        let permissions = None;
        Ok(crate::types::EntryMeta {
            kind,
            size,
            modified_ms,
            permissions,
        })
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
        tokio::fs::rename(from, to).await.map_err(DuetError::from)
    }

    async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
        // create_dir (not _all) — 부모 없으면 에러, 이미 있으면 에러
        tokio::fs::create_dir(path).await.map_err(DuetError::from)
    }

    async fn trash(&self, _: &Path, _: &str) -> Result<crate::types::TrashLocation, DuetError> {
        unimplemented!("Task 8")
    }

    async fn remove(&self, path: &Path) -> Result<(), DuetError> {
        let m = tokio::fs::symlink_metadata(path)
            .await
            .map_err(DuetError::from)?;
        if m.is_dir() {
            tokio::fs::remove_dir_all(path)
                .await
                .map_err(DuetError::from)
        } else {
            tokio::fs::remove_file(path).await.map_err(DuetError::from)
        }
    }
    async fn restore_from_trash(
        &self,
        _: &crate::types::TrashLocation,
        _: &Path,
    ) -> Result<(), DuetError> {
        unimplemented!("Task 8")
    }
    async fn read_full(&self, _: &Path) -> Result<Vec<u8>, DuetError> {
        unimplemented!("Task 9")
    }
    async fn write_full(&self, _: &Path, _: &[u8]) -> Result<(), DuetError> {
        unimplemented!("Task 9")
    }

    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        let mut read_dir = tokio::fs::read_dir(path).await.map_err(DuetError::from)?;
        let mut entries = Vec::new();

        while let Some(entry) = read_dir.next_entry().await.map_err(DuetError::from)? {
            let name = match entry.file_name().into_string() {
                Ok(s) => s,
                Err(_) => continue, // 비-UTF8 이름은 스킵
            };
            let metadata = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue, // 권한 없는 항목은 스킵 (전체 list는 진행)
            };
            let kind = if metadata.is_dir() {
                EntryKind::Dir
            } else if metadata.is_file() {
                EntryKind::File
            } else if metadata.is_symlink() {
                EntryKind::Symlink
            } else {
                EntryKind::Other
            };
            let size = if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            };
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            #[cfg(unix)]
            let permissions = {
                use std::os::unix::fs::PermissionsExt;
                Some(metadata.permissions().mode() & 0o777)
            };
            #[cfg(not(unix))]
            let permissions = None;

            let hidden = name.starts_with('.') || is_os_hidden(&metadata);

            entries.push(Entry {
                name,
                kind,
                size,
                modified_ms,
                permissions,
                hidden,
            });
        }

        Ok(entries)
    }
}

#[cfg(windows)]
fn is_os_hidden(meta: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    (meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN) != 0
}

#[cfg(not(windows))]
fn is_os_hidden(_meta: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use tokio::fs;

    #[tokio::test]
    async fn list_empty_directory_returns_empty() {
        let dir = TempDir::new().unwrap();
        let local = LocalFs::new();
        let entries = local.list(dir.path()).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn list_returns_files_and_dirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello").await.unwrap();
        fs::create_dir(dir.path().join("sub")).await.unwrap();

        let local = LocalFs::new();
        let mut entries = local.list(dir.path()).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "a.txt");
        assert_eq!(entries[0].kind, EntryKind::File);
        assert_eq!(entries[0].size, Some(5));
        assert_eq!(entries[1].name, "sub");
        assert_eq!(entries[1].kind, EntryKind::Dir);
    }

    #[tokio::test]
    async fn list_marks_dotfiles_as_hidden() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".hidden"), b"").await.unwrap();
        fs::write(dir.path().join("visible.txt"), b"")
            .await
            .unwrap();

        let local = LocalFs::new();
        let entries = local.list(dir.path()).await.unwrap();

        let hidden = entries.iter().find(|e| e.name == ".hidden").unwrap();
        let visible = entries.iter().find(|e| e.name == "visible.txt").unwrap();
        assert!(hidden.hidden);
        assert!(!visible.hidden);
    }

    #[tokio::test]
    async fn list_nonexistent_returns_not_found() {
        let local = LocalFs::new();
        let result = local
            .list(Path::new("/this/path/should/not/exist/duet-test"))
            .await;
        assert!(matches!(result, Err(DuetError::NotFound(_))));
    }

    #[tokio::test]
    async fn rename_renames_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), b"x").await.unwrap();
        let local = LocalFs::new();
        local
            .rename(&dir.path().join("a.txt"), &dir.path().join("b.txt"))
            .await
            .unwrap();
        assert!(!dir.path().join("a.txt").exists());
        assert!(dir.path().join("b.txt").exists());
    }

    #[tokio::test]
    async fn mkdir_creates_dir() {
        let dir = TempDir::new().unwrap();
        let local = LocalFs::new();
        local.mkdir(&dir.path().join("new")).await.unwrap();
        assert!(dir.path().join("new").is_dir());
    }

    #[tokio::test]
    async fn mkdir_fails_if_exists() {
        let dir = TempDir::new().unwrap();
        let local = LocalFs::new();
        fs::create_dir(dir.path().join("x")).await.unwrap();
        let result = local.mkdir(&dir.path().join("x")).await;
        assert!(result.is_err(), "기존 디렉토리에 mkdir 은 실패해야 함");
    }

    #[tokio::test]
    async fn remove_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a"), b"").await.unwrap();
        let local = LocalFs::new();
        local.remove(&dir.path().join("a")).await.unwrap();
        assert!(!dir.path().join("a").exists());
    }

    #[tokio::test]
    async fn remove_empty_dir() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("empty")).await.unwrap();
        let local = LocalFs::new();
        local.remove(&dir.path().join("empty")).await.unwrap();
        assert!(!dir.path().join("empty").exists());
    }

    #[tokio::test]
    async fn remove_nonempty_dir_recursive() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("d")).await.unwrap();
        fs::write(dir.path().join("d/a"), b"").await.unwrap();
        let local = LocalFs::new();
        local.remove(&dir.path().join("d")).await.unwrap();
        assert!(!dir.path().join("d").exists());
    }

    #[tokio::test]
    async fn metadata_returns_kind_size() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a"), b"hello").await.unwrap();
        let local = LocalFs::new();
        let m = local.metadata(&dir.path().join("a")).await.unwrap();
        assert_eq!(m.kind, EntryKind::File);
        assert_eq!(m.size, Some(5));
    }
}
