//! 파일시스템 추상화.
//!
//! `LocalFs` (local), `SshFs` (MVP-1), `MockFs` (테스트) 모두 이 trait 구현.
//! 모든 메서드는 `async` — Tauri tokio runtime 위에서 동작.

pub mod local;
pub mod ssh;

use crate::types::{DuetError, Entry, SourceId};
use async_trait::async_trait;
use std::path::Path;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

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
    /// 단일 파일 전체 읽기. 큰 파일은 메모리 폭주 위험 — 복사는 `open_read`/`open_write`
    /// 스트리밍 사용. 이건 작은 파일(설정/미리보기 등) 전용.
    async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError>;
    /// 단일 파일 전체 쓰기.
    async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError>;

    /// 스트리밍 읽기 핸들 — 큰 파일을 전부 메모리에 올리지 않고 chunk 로 읽기 위함.
    /// `offset>0` 이면 그 위치부터 (재개 복사용).
    async fn open_read(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError>;

    /// 스트리밍 쓰기 핸들. `offset==0` 이면 생성+truncate, `offset>0` 이면 기존 파일을
    /// 열어 그 위치부터 이어쓰기(재개). `flush`/`shutdown` 은 호출자 책임.
    async fn open_write(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError>;
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

/// relay 스트리밍 복사 버퍼 — 한 번에 메모리에 올리는 최대 바이트.
/// 전체 파일이 아니라 이 크기씩 흘려보내 큰 파일에서도 메모리 bounded.
const RELAY_CHUNK: usize = 256 * 1024;

/// 본인 PC 통한 stream copy. local↔ssh 양방향 OK; ssh↔ssh 는 호출 전에
/// `core::ops` 가 same-host 검사 하고 차단.
///
/// 디렉토리는 재귀: src 가 dir 이면 dst 에 mkdir 후 자식 entries 차례로 복사.
/// 파일은 chunk 스트리밍 — 전체를 메모리에 올리지 않음(대용량 안전). 진행률/취소가
/// 필요하면 `copy_relay_streaming` 사용.
pub async fn copy_relay(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
) -> Result<(), DuetError> {
    // 진행률/취소 없는 호출(undo 등) — 절대 취소 안 되는 토큰 + no-op 콜백, 재개 없음.
    let cancel = CancellationToken::new();
    copy_tree(src_fs, src, dst_fs, dst, false, &cancel, &|_| {}).await
}

/// `copy_relay` 의 진행률/취소/재개 지원 변형. `on_bytes(delta)` 는 파일에서 쓴
/// 바이트 증분마다 호출(진행률 emit 용). `cancel` 은 chunk 경계마다 검사.
/// `resume=true` 면 중단된 `.part` 의 현재 크기부터 이어쓰기(전송 재개).
pub async fn copy_relay_streaming(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
    resume: bool,
    cancel: &CancellationToken,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), DuetError> {
    copy_tree(src_fs, src, dst_fs, dst, resume, cancel, on_bytes).await
}

async fn copy_tree(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
    resume: bool,
    cancel: &CancellationToken,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), DuetError> {
    let meta = src_fs.metadata(src).await?;
    match meta.kind {
        crate::types::EntryKind::Dir => {
            dst_fs.mkdir(dst).await?;
            let entries = src_fs.list(src).await?;
            for e in entries {
                let child_src = src.join(&e.name);
                let child_dst = dst.join(&e.name);
                Box::pin(copy_tree(
                    src_fs, &child_src, dst_fs, &child_dst, resume, cancel, on_bytes,
                ))
                .await?;
            }
            Ok(())
        }
        // Symlink/Other 는 target 내용을 따라가 복사 (MVP-2).
        _ => stream_copy_file(src_fs, src, dst_fs, dst, resume, cancel, on_bytes).await,
    }
}

/// `<dst>.duet-part` 임시 경로 — 완성 전까지 여기에 쓰고, 끝나면 dst 로 rename.
/// 중단되면 dst(최종 이름)는 안 생기고 .part 만 남아 재개에 쓰인다.
fn part_path(dst: &std::path::Path) -> std::path::PathBuf {
    let mut s = dst.as_os_str().to_os_string();
    s.push(".duet-part");
    std::path::PathBuf::from(s)
}

/// 단일 파일을 고정 버퍼로 흘려 복사 — 전체를 메모리에 올리지 않음(대용량 안전).
/// `<dst>.duet-part` 에 쓴 뒤 dst 로 rename(중단 시 반쪽 파일을 최종 이름에 안 남김).
/// `resume=true` 면 기존 .part 크기부터 이어쓰기. chunk 경계마다 취소 검사 + `on_bytes`.
async fn stream_copy_file(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
    resume: bool,
    cancel: &CancellationToken,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), DuetError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let part = part_path(dst);
    // 재개 시작 오프셋 = 기존 .part 의 실제 크기 (실제 persist 된 만큼). fresh 면 0.
    let start = if resume {
        dst_fs
            .metadata(&part)
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0)
    } else {
        0
    };
    let mut reader = src_fs.open_read(src, start).await?;
    let mut writer = dst_fs.open_write(&part, start).await?;
    let mut buf = vec![0u8; RELAY_CHUNK];
    loop {
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let n = reader
            .read(&mut buf)
            .await
            .map_err(|e| DuetError::Io(format!("copy read: {e}")))?;
        if n == 0 {
            break;
        }
        writer
            .write_all(&buf[..n])
            .await
            .map_err(|e| DuetError::Io(format!("copy write: {e}")))?;
        on_bytes(n as u64);
    }
    writer
        .flush()
        .await
        .map_err(|e| DuetError::Io(format!("copy flush: {e}")))?;
    writer
        .shutdown()
        .await
        .map_err(|e| DuetError::Io(format!("copy close: {e}")))?;
    // 완성 — .part 를 최종 이름으로. dst 가 이미 있으면(예: dir 재시도로 재복사된
    // 완료 파일; 호출자가 사전 백업 보장) 우리 것이므로 제거 후 rename (SFTP rename 은
    // 기존 파일에 실패할 수 있어 명시 제거).
    if let Err(e) = dst_fs.rename(&part, dst).await {
        if dst_fs.metadata(dst).await.is_ok() {
            dst_fs.remove(dst).await?;
            dst_fs.rename(&part, dst).await?;
        } else {
            return Err(e);
        }
    }
    Ok(())
}
