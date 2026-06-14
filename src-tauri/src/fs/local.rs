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

    async fn trash(
        &self,
        path: &Path,
        _batch_id: &str,
    ) -> Result<crate::types::TrashLocation, DuetError> {
        let path = path.to_path_buf();
        // trash crate 는 sync — spawn_blocking
        let trash_id = tokio::task::spawn_blocking(move || trash_delete_capture_id(&path))
            .await
            .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))??;
        Ok(crate::types::TrashLocation::Local { trash_id })
    }

    async fn restore_from_trash(
        &self,
        location: &crate::types::TrashLocation,
        original_path: &Path,
    ) -> Result<(), DuetError> {
        let crate::types::TrashLocation::Local { trash_id } = location else {
            return Err(DuetError::Io(
                "restore_from_trash on local fs given non-local location".into(),
            ));
        };
        let trash_id = trash_id.clone();
        let original = original_path.to_path_buf();
        tokio::task::spawn_blocking(move || trash_restore(&trash_id, &original))
            .await
            .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
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
    async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError> {
        tokio::fs::read(path).await.map_err(DuetError::from)
    }

    async fn read_head(&self, path: &Path, max: usize) -> Result<(Vec<u8>, bool), DuetError> {
        let mut file = tokio::fs::File::open(path).await.map_err(DuetError::from)?;
        let mut buf = vec![0u8; max.saturating_add(1)];
        let n = crate::fs::read_upto(&mut file, &mut buf)
            .await
            .map_err(DuetError::from)?;
        let truncated = n > max;
        buf.truncate(n.min(max));
        Ok((buf, truncated))
    }

    async fn read_range(&self, path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, DuetError> {
        use tokio::io::AsyncSeekExt;
        let mut file = tokio::fs::File::open(path).await.map_err(DuetError::from)?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(DuetError::from)?;
        let mut buf = vec![0u8; len];
        let n = crate::fs::read_upto(&mut file, &mut buf)
            .await
            .map_err(DuetError::from)?;
        buf.truncate(n);
        Ok(buf)
    }

    async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
        tokio::fs::write(path, bytes).await.map_err(DuetError::from)
    }

    async fn open_read(
        &self,
        path: &Path,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        let file = tokio::fs::File::open(path).await.map_err(DuetError::from)?;
        Ok(Box::pin(file))
    }

    async fn open_write(
        &self,
        path: &Path,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        // create + truncate (write_full 과 동일 의미).
        let file = tokio::fs::File::create(path)
            .await
            .map_err(DuetError::from)?;
        Ok(Box::pin(file))
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

// === Trash helpers (sync — spawn_blocking 안에서 호출) ===

/// OS 휴지통으로 보내고 복원에 쓸 native id 반환.
/// Linux/Windows: trash crate 의 native TrashItem id.
/// macOS: 원본 절대경로 string (restore 는 NotSupported — undo 시도 시 명시 거부).
#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn trash_delete_capture_id(path: &Path) -> Result<String, DuetError> {
    use trash::os_limited;
    let items_before: std::collections::HashSet<_> = os_limited::list()
        .map_err(|e| DuetError::Io(format!("trash list before: {e}")))?
        .into_iter()
        .map(|i| i.id)
        .collect();
    trash::delete(path).map_err(|e| DuetError::Io(format!("trash delete: {e}")))?;
    let after = os_limited::list().map_err(|e| DuetError::Io(format!("trash list after: {e}")))?;
    let new = after
        .into_iter()
        .find(|i| !items_before.contains(&i.id) && i.original_path() == path)
        .ok_or_else(|| DuetError::Io("trash item not found after delete".into()))?;
    Ok(new.id.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn trash_delete_capture_id(path: &Path) -> Result<String, DuetError> {
    // macOS 에서 trash crate 의 os_limited::list/restore_all 미지원.
    // delete 는 OS Trash 로 mv 됨 — 동작. id 는 원본 절대경로 string 으로
    // 기록 (현재 restore 미지원이지만 후속에서 ~/.Trash/<basename> 기반 mv
    // 추가 가능).
    trash::delete(path).map_err(|e| DuetError::Io(format!("trash delete: {e}")))?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(any(target_os = "windows", all(unix, not(target_os = "macos"))))]
fn trash_restore(trash_id: &str, original: &Path) -> Result<(), DuetError> {
    use trash::os_limited;
    if original.exists() {
        return Err(DuetError::Io(format!(
            "restore target exists: {}",
            original.display()
        )));
    }
    let items = os_limited::list().map_err(|e| DuetError::Io(format!("trash list: {e}")))?;
    let item = items
        .into_iter()
        .find(|i| i.id.to_string_lossy() == trash_id)
        .ok_or_else(|| DuetError::Io(format!("trash item not found: {trash_id}")))?;
    os_limited::restore_all([item]).map_err(|e| DuetError::Io(format!("restore: {e:?}")))
}

#[cfg(target_os = "macos")]
fn trash_restore(_trash_id: &str, _original: &Path) -> Result<(), DuetError> {
    // MVP-2: macOS undo-from-trash 미지원 (trash crate os_limited 가 macOS 에서
    // restore_all 제공 안 함). 사용자는 Finder 에서 수동 복원 필요.
    // 후속에서 ~/.Trash/<basename> 기반 mv 로 best-effort 복원 추가 검토.
    Err(DuetError::NotSupported(
        "trash undo on macOS — restore manually via Finder".into(),
    ))
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

    #[tokio::test]
    async fn read_head_truncates_and_flags() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("big"), b"0123456789")
            .await
            .unwrap();
        let local = LocalFs::new();
        // 앞 4바이트만 + 더 있음.
        let (head, truncated) = local.read_head(&dir.path().join("big"), 4).await.unwrap();
        assert_eq!(head, b"0123");
        assert!(truncated);
        // cap 이 전체 이상이면 truncated=false.
        let (full, t2) = local.read_head(&dir.path().join("big"), 100).await.unwrap();
        assert_eq!(full, b"0123456789");
        assert!(!t2);
    }

    #[tokio::test]
    async fn read_range_seeks_and_clamps() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("f"), b"0123456789")
            .await
            .unwrap();
        let local = LocalFs::new();
        let p = dir.path().join("f");
        // 중간 범위.
        assert_eq!(local.read_range(&p, 2, 3).await.unwrap(), b"234");
        // 끝을 넘는 len 은 clamp.
        assert_eq!(local.read_range(&p, 8, 100).await.unwrap(), b"89");
        // offset 이 EOF 이상이면 빈 결과.
        assert_eq!(local.read_range(&p, 50, 10).await.unwrap(), b"");
    }

    #[tokio::test]
    async fn copy_relay_local_to_local_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a"), b"hello").await.unwrap();
        let local = LocalFs::new();
        crate::fs::copy_relay(&local, &dir.path().join("a"), &local, &dir.path().join("b"))
            .await
            .unwrap();
        let b = fs::read(dir.path().join("b")).await.unwrap();
        assert_eq!(b, b"hello");
    }

    #[tokio::test]
    async fn copy_relay_local_to_local_dir_recursive() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("src/sub"))
            .await
            .unwrap();
        fs::write(dir.path().join("src/a"), b"A").await.unwrap();
        fs::write(dir.path().join("src/sub/b"), b"B").await.unwrap();
        let local = LocalFs::new();
        crate::fs::copy_relay(
            &local,
            &dir.path().join("src"),
            &local,
            &dir.path().join("dst"),
        )
        .await
        .unwrap();
        assert_eq!(fs::read(dir.path().join("dst/a")).await.unwrap(), b"A");
        assert_eq!(fs::read(dir.path().join("dst/sub/b")).await.unwrap(), b"B");
    }

    /// 다중 chunk 파일(>256KB)을 스트리밍 복사 — chunk 경계 정확성 + 진행률 누적 확인.
    /// 전체를 메모리에 안 올리는 경로가 바이트 단위로 정확한지 검증.
    #[tokio::test]
    async fn copy_relay_streaming_multichunk_exact_and_progress() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let dir = TempDir::new().unwrap();
        // 256KB(RELAY_CHUNK) 경계를 여러 번 넘는 크기 + 비정렬 꼬리.
        let size = 256 * 1024 * 3 + 777;
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        fs::write(dir.path().join("big.bin"), &data).await.unwrap();

        let local = LocalFs::new();
        let counted = AtomicU64::new(0);
        let on_bytes = |delta: u64| {
            counted.fetch_add(delta, Ordering::Relaxed);
        };
        let cancel = tokio_util::sync::CancellationToken::new();
        crate::fs::copy_relay_streaming(
            &local,
            &dir.path().join("big.bin"),
            &local,
            &dir.path().join("out.bin"),
            &cancel,
            &on_bytes,
        )
        .await
        .unwrap();

        let out = fs::read(dir.path().join("out.bin")).await.unwrap();
        assert_eq!(out.len(), size);
        assert_eq!(out, data, "byte-exact across chunk boundaries");
        assert_eq!(
            counted.load(Ordering::Relaxed),
            size as u64,
            "progress sums to size"
        );
    }

    /// 이미 취소된 토큰이면 첫 chunk 전에 Cancelled.
    #[tokio::test]
    async fn copy_relay_streaming_honors_cancel() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a"), vec![0u8; 512 * 1024])
            .await
            .unwrap();
        let local = LocalFs::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel();
        let r = crate::fs::copy_relay_streaming(
            &local,
            &dir.path().join("a"),
            &local,
            &dir.path().join("b"),
            &cancel,
            &|_| {},
        )
        .await;
        assert!(matches!(r, Err(DuetError::Cancelled)));
    }
}
