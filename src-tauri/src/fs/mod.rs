//! 파일시스템 추상화.
//!
//! `LocalFs` (local), `SshFs` (MVP-1), `MockFs` (테스트) 모두 이 trait 구현.
//! 모든 메서드는 `async` — Tauri tokio runtime 위에서 동작.

pub mod local;
pub mod ssh;

use crate::types::{DuetError, Entry, SourceId};
use async_trait::async_trait;
use std::path::Path;

pub use local::LocalFs;
pub use ssh::SshFs;

#[async_trait]
pub trait FileSystem: Send + Sync {
    /// 이 파일시스템의 식별자.
    /// 같은-호스트 판정에 사용 (`SourceId::Ssh.host_ip` 일치 시 same-host).
    fn source_id(&self) -> SourceId;

    /// 디렉토리 항목 나열. 정렬은 호출자 책임.
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError>;

    // === MVP-2 신규 ===
    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError>;
    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError>;
    async fn mkdir(&self, path: &Path) -> Result<(), DuetError>;
    async fn trash(
        &self,
        path: &Path,
        batch_id: &str,
    ) -> Result<crate::types::TrashLocation, DuetError>;
    async fn remove(&self, path: &Path) -> Result<(), DuetError>;
    /// trash 의 역동작 — undo 용. local/remote 구분 필요.
    async fn restore_from_trash(
        &self,
        location: &crate::types::TrashLocation,
        original_path: &Path,
    ) -> Result<(), DuetError>;
    /// 단일 파일 전체 읽기. 큰 파일은 메모리 폭주 위험 — 후속에서 streaming 화.
    async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError>;
    /// 단일 파일 전체 쓰기.
    async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError>;
    /// 파일 앞부분만 읽기 (미리보기용) — 최대 `max` 바이트, 더 있으면 `truncated=true`.
    ///
    /// 기본 구현은 `read_full` 후 절단(큰 파일 비효율) — impl 별 override 로
    /// 부분 읽기 권장.
    async fn read_head(&self, path: &Path, max: usize) -> Result<(Vec<u8>, bool), DuetError> {
        let full = self.read_full(path).await?;
        let truncated = full.len() > max;
        let mut head = full;
        head.truncate(max);
        Ok((head, truncated))
    }

    /// 파일의 `[offset, offset+len)` 바이트 범위 읽기 (스트리밍 미리보기 Range 응답용).
    /// 파일 끝을 넘으면 가능한 만큼만 반환. 기본 구현은 `read_full` 후 슬라이스
    /// (비효율) — impl 별 seek 기반 override 권장.
    async fn read_range(&self, path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, DuetError> {
        let full = self.read_full(path).await?;
        let start = (offset as usize).min(full.len());
        let end = start.saturating_add(len).min(full.len());
        Ok(full[start..end].to_vec())
    }
}

/// reader 에서 최대 `buf.len()` 바이트 채울 때까지 반복 read (짧은 read 대응).
/// 반환값은 실제 채운 바이트 수 (EOF 면 buf 보다 작음).
pub(crate) async fn read_upto<R>(reader: &mut R, buf: &mut [u8]) -> std::io::Result<usize>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;
    let mut total = 0;
    while total < buf.len() {
        let n = reader.read(&mut buf[total..]).await?;
        if n == 0 {
            break;
        }
        total += n;
    }
    Ok(total)
}

/// 본인 PC 통한 stream copy. local↔ssh 양방향 OK; ssh↔ssh 는 호출 전에
/// `core::ops` 가 same-host 검사 하고 차단.
///
/// 디렉토리는 재귀: src 가 dir 이면 dst 에 mkdir 후 자식 entries 차례로 복사.
pub async fn copy_relay(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
) -> Result<(), DuetError> {
    let meta = src_fs.metadata(src).await?;
    match meta.kind {
        crate::types::EntryKind::Dir => {
            dst_fs.mkdir(dst).await?;
            let entries = src_fs.list(src).await?;
            for e in entries {
                let child_src = src.join(&e.name);
                let child_dst = dst.join(&e.name);
                Box::pin(copy_relay(src_fs, &child_src, dst_fs, &child_dst)).await?;
            }
            Ok(())
        }
        crate::types::EntryKind::File => copy_file_bytes(src_fs, src, dst_fs, dst).await,
        crate::types::EntryKind::Symlink | crate::types::EntryKind::Other => {
            // MVP-2 는 symlink 따라가서 복사 (target 의 내용 복사).
            copy_file_bytes(src_fs, src, dst_fs, dst).await
        }
    }
}

async fn copy_file_bytes(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
) -> Result<(), DuetError> {
    let bytes = src_fs.read_full(src).await?;
    dst_fs.write_full(dst, &bytes).await
}
