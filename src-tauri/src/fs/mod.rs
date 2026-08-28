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

/// POSIX 경로 결합 — `base` 끝 `/` 정리 후 `/name`. **이름은 opaque**(`\` 등 그대로 보존).
/// 호스트 OS 무관(Windows 에서도 `/` 사용). SshFs::join 과 same-host(core) 가 공유한다.
/// 원격(리눅스) 파일명에 `\` 가 들어가도 깨지지 않게 하는 핵심.
pub fn posix_join(base: &Path, name: &str) -> std::path::PathBuf {
    let b = base.to_string_lossy();
    let b = b.trim_end_matches('/');
    if b.is_empty() {
        std::path::PathBuf::from(format!("/{name}"))
    } else {
        std::path::PathBuf::from(format!("{b}/{name}"))
    }
}

#[async_trait]
pub trait FileSystem: Send + Sync {
    /// 이 파일시스템의 식별자.
    /// 같은-호스트 판정에 사용 (`SourceId::Ssh.host_ip` 일치 시 same-host).
    fn source_id(&self) -> SourceId;

    /// 디렉토리 경로 + 항목 이름 → 자식 경로. **이 fs 의 구분자 규칙**으로 결합한다.
    ///
    /// 기본(로컬): 호스트 OS 의 `Path::join`. SSH 는 항상 POSIX(`/`)로 결합하도록 override —
    /// Windows 호스트에서 `PathBuf::join` 이 `\` 를 끼워넣거나, 이름에 들어간 `\`(리눅스 파일명
    /// 은 `\` 허용)를 구분자로 오해해 원격 경로가 깨지는 걸 막는다. (§7: 구분자 분기는 여기서.)
    fn join(&self, base: &Path, name: &str) -> std::path::PathBuf {
        base.join(name)
    }

    /// 디렉토리 항목 나열. 정렬은 호출자 책임.
    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError>;

    // === MVP-2 신규 ===
    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError>;
    /// 심볼릭 링크를 **따라가지 않는** 메타데이터(lstat). 재귀 복사/삭제가 링크 *대상*
    /// 트리로 들어가는 걸 막는 판정용. 기본은 `metadata` 와 동일 — LocalFs 는 이미 lstat.
    /// SshFs 의 `metadata` 는 stat(follow)이므로 override 해서 lstat 를 쓴다.
    async fn symlink_metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError> {
        self.metadata(path).await
    }
    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError>;
    async fn mkdir(&self, path: &Path) -> Result<(), DuetError>;
    async fn trash(
        &self,
        path: &Path,
        batch_id: &str,
    ) -> Result<crate::types::TrashLocation, DuetError>;
    /// 여러 항목을 **한 번에** 휴지통으로. 반환값은 실제로 사라진 항목만(순서 유지) +
    /// 첫 실패(있으면). 부분 성공도 호출자가 journal 에 남길 수 있어야 하므로 둘 다 준다.
    ///
    /// 기본 구현은 `trash` 를 순차 호출(원격은 mv 라 배치 이득이 없다). 로컬은 OS 휴지통
    /// API 를 항목마다 부르는 비용이 커서 오버라이드한다.
    async fn trash_many(
        &self,
        paths: &[std::path::PathBuf],
        batch_id: &str,
    ) -> (
        Vec<(std::path::PathBuf, crate::types::TrashLocation)>,
        Option<DuetError>,
    ) {
        let mut done = Vec::with_capacity(paths.len());
        for p in paths {
            match self.trash(p, batch_id).await {
                Ok(loc) => done.push((p.clone(), loc)),
                Err(e) => return (done, Some(e)),
            }
        }
        (done, None)
    }
    async fn remove(&self, path: &Path) -> Result<(), DuetError>;
    /// trash 의 역동작 — undo 용. local/remote 구분 필요.
    async fn restore_from_trash(
        &self,
        location: &crate::types::TrashLocation,
        original_path: &Path,
    ) -> Result<(), DuetError>;
    /// `restore_from_trash` 의 배치판 — undo 가 한 번에 여러 항목을 되돌릴 때.
    /// 기본 구현은 순차 호출. 로컬은 휴지통 목록 조회를 배치당 1회로 줄이려고 오버라이드한다.
    async fn restore_many(
        &self,
        items: &[(crate::types::TrashLocation, std::path::PathBuf)],
    ) -> Result<(), DuetError> {
        for (loc, original) in items {
            self.restore_from_trash(loc, original).await?;
        }
        Ok(())
    }
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

    /// 경로의 총 바이트 크기(디렉토리면 하위 전체 재귀 합). 복사/이동 진행률의 분모로 쓴다.
    /// 기본 구현은 `list`+`metadata` 재귀 — 로컬엔 빠르지만 SSH 는 round-trip 폭주라
    /// `du -sb` override 권장. 파일은 `metadata().size`.
    async fn dir_size(&self, path: &Path) -> Result<u64, DuetError> {
        let meta = self.metadata(path).await?;
        if !matches!(meta.kind, crate::types::EntryKind::Dir) {
            return Ok(meta.size.unwrap_or(0));
        }
        let mut total = 0u64;
        for e in self.list(path).await? {
            // async_trait 는 메서드를 Box<Future> 로 desugar — 재귀는 그냥 호출.
            total += self.dir_size(&path.join(&e.name)).await?;
        }
        Ok(total)
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

    /// POSIX 권한(mode, 0o777 비트) 변경. `recursive` 는 하위 전체(심볼릭 링크는
    /// 안 따라감). 기본 구현은 NotSupported — 로컬 unix / SSH 가 override.
    async fn set_mode(&self, path: &Path, mode: u32, recursive: bool) -> Result<(), DuetError> {
        let _ = (path, mode, recursive);
        Err(DuetError::NotSupported(
            "permissions are not supported on this filesystem".into(),
        ))
    }

    /// 소유자/그룹 변경(chown). 원격(SSH) 전용 — 로컬은 보통 root 필요라 NotSupported.
    async fn set_owner(
        &self,
        path: &Path,
        owner: Option<&str>,
        group: Option<&str>,
        recursive: bool,
    ) -> Result<(), DuetError> {
        let _ = (path, owner, group, recursive);
        Err(DuetError::NotSupported(
            "ownership change is not supported on this filesystem".into(),
        ))
    }

    /// 심볼릭 링크 생성 — `target` 문자열 그대로 사용(상대/절대 유지, 존재 검증 안 함
    /// — 의도적 dangling 링크 허용). 기본 구현은 NotSupported.
    async fn make_symlink(&self, link: &Path, target: &str) -> Result<(), DuetError> {
        let _ = (link, target);
        Err(DuetError::NotSupported(
            "symlink creation is not supported on this filesystem".into(),
        ))
    }

    /// 파일 체크섬(소문자 hex) — 무결성 확인용. 기본 구현은 `open_read` 청크 스트리밍
    /// 해시(메모리 bounded). SSH 는 호스트측 `sha256sum` 오버라이드(다운로드 0) 권장.
    async fn checksum(
        &self,
        path: &Path,
        algo: crate::types::ChecksumAlgo,
    ) -> Result<String, DuetError> {
        let reader = self.open_read(path, 0).await?;
        match algo {
            crate::types::ChecksumAlgo::Sha256 => hash_stream::<sha2::Sha256>(reader).await,
            crate::types::ChecksumAlgo::Sha512 => hash_stream::<sha2::Sha512>(reader).await,
        }
    }
}

/// AsyncRead 를 청크로 소진하며 Digest 해시 → 소문자 hex. (trait 기본 checksum 용)
async fn hash_stream<D: sha2::Digest>(
    mut reader: std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>,
) -> Result<String, DuetError> {
    let mut hasher = D::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = read_upto(&mut reader, &mut buf)
            .await
            .map_err(|e| DuetError::Io(format!("checksum read: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
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
/// 로컬→로컬 청크 — 네트워크가 아니라 왕복 지연이 없으니 크게 잡아 blocking 풀
/// 왕복 횟수를 줄인다(256 KiB 로는 GB 단위 파일에서 왕복만 수천 번).
const LOCAL_CHUNK: usize = 4 * 1024 * 1024;
/// 이 크기 이하의 로컬→로컬 파일은 OS 복사 API 한 번으로 처리(중간 취소·진행률 없음).
/// 작은 파일 다수가 느리던 주원인이 파일당 open/read/write/close 왕복이었다.
/// 이보다 큰 파일은 청크 스트리밍 유지 — 중간 취소와 바이트 진행률이 더 중요하다.
const NATIVE_COPY_MAX: u64 = 64 * 1024 * 1024;

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
    copy_tree(src_fs, src, dst_fs, dst, false, &cancel, &|_| {}, &|_| {}).await
}

/// `copy_relay` 의 진행률/취소/재개 지원 변형. `on_bytes(delta)` 는 파일에서 쓴
/// 바이트 증분마다 호출(진행률 emit 용). `on_file(src_path)` 는 **각 파일 복사 시작 시**
/// 그 파일 경로로 호출(현재 파일명 표시용 — 폴더 내부도 개별 파일까지). `cancel` 은 chunk
/// 경계마다 검사. `resume=true` 면 중단된 `.part` 의 현재 크기부터 이어쓰기(전송 재개).
#[allow(clippy::too_many_arguments)]
pub async fn copy_relay_streaming(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
    resume: bool,
    cancel: &CancellationToken,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
    on_file: &(dyn Fn(&std::path::Path) + Send + Sync),
) -> Result<(), DuetError> {
    copy_tree(src_fs, src, dst_fs, dst, resume, cancel, on_bytes, on_file).await
}

#[allow(clippy::too_many_arguments)]
async fn copy_tree(
    src_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst_fs: &dyn FileSystem,
    dst: &std::path::Path,
    resume: bool,
    cancel: &CancellationToken,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
    on_file: &(dyn Fn(&std::path::Path) + Send + Sync),
) -> Result<(), DuetError> {
    // lstat 로 판정 — 심볼릭-디렉토리를 따라가 재귀하지 않게(원격 symlink 무한 복사/사이클
    // 방지). 링크는 아래 `_` 갈래로 가서 단일 항목으로 처리(파일 내용은 open_read 가 따라감).
    let meta = src_fs.symlink_metadata(src).await?;
    match meta.kind {
        crate::types::EntryKind::Dir => {
            dst_fs.mkdir(dst).await?;
            let entries = src_fs.list(src).await?;
            for e in entries {
                // 각 fs 의 구분자 규칙으로 결합(원격=POSIX, 이름의 `\` 보존).
                let child_src = src_fs.join(src, &e.name);
                let child_dst = dst_fs.join(dst, &e.name);
                Box::pin(copy_tree(
                    src_fs, &child_src, dst_fs, &child_dst, resume, cancel, on_bytes, on_file,
                ))
                .await?;
            }
            Ok(())
        }
        // Symlink/Other 는 target 내용을 따라가 복사 (MVP-2).
        _ => {
            on_file(src); // 현재 복사 중인 실제 파일 알림(폴더 내부 개별 파일 포함)
                          // 로컬→로컬 + 적당한 크기 = OS 복사 API 한 번(Windows CopyFileExW /
                          // macOS fclonefileat·fcopyfile / Linux copy_file_range). 재개(resume)는
                          // 네트워크 전용이라 여기 해당 없음.
            if !resume
                && both_local(src_fs, dst_fs)
                && matches!(meta.kind, crate::types::EntryKind::File)
                && meta.size.unwrap_or(u64::MAX) <= NATIVE_COPY_MAX
            {
                if cancel.is_cancelled() {
                    return Err(DuetError::Cancelled);
                }
                return native_copy_file(dst_fs, src, dst, on_bytes).await;
            }
            stream_copy_file(src_fs, src, dst_fs, dst, resume, cancel, on_bytes).await
        }
    }
}

/// 양쪽 모두 로컬 파일시스템인가 — OS 복사 API 를 쓸 수 있는 조건.
fn both_local(src_fs: &dyn FileSystem, dst_fs: &dyn FileSystem) -> bool {
    matches!(src_fs.source_id(), crate::types::SourceId::Local)
        && matches!(dst_fs.source_id(), crate::types::SourceId::Local)
}

/// OS 파일 복사 API 로 한 번에 — `.part` 에 쓰고 rename 하는 실패-안전 규칙은 동일.
/// 진행률은 파일 단위(완료 시 크기만큼 한 번). 중간 취소는 안 되므로 호출자가 크기로 거른다.
async fn native_copy_file(
    dst_fs: &dyn FileSystem,
    src: &std::path::Path,
    dst: &std::path::Path,
    on_bytes: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), DuetError> {
    let part = part_path(dst);
    let (from, to) = (src.to_path_buf(), part.clone());
    let written = tokio::task::spawn_blocking(move || {
        let n = std::fs::copy(&from, &to)?;
        // 원본 수정시각 보존 — 탐색기/TC 관례. 스트리밍 경로도 아래에서 같이 맞춘다.
        copy_mtime(&from, &to);
        Ok::<u64, std::io::Error>(n)
    })
    .await
    .map_err(|e| DuetError::Io(format!("spawn_blocking: {e}")))?
    .map_err(|e| DuetError::Io(format!("copy: {e}")))?;
    on_bytes(written);
    finalize_part(dst_fs, &part, dst).await
}

/// src 의 수정시각을 dst 에 반영 — 실패는 무시(내용은 이미 복사됨, 시각은 부가).
/// 이게 없으면 복사 직후 dst 가 항상 "더 최신"이라 비교/동기화가 어긋난다.
fn copy_mtime(src: &std::path::Path, dst: &std::path::Path) {
    let Ok(meta) = std::fs::metadata(src) else {
        return;
    };
    let Ok(mtime) = meta.modified() else {
        return;
    };
    let Ok(f) = std::fs::File::options().write(true).open(dst) else {
        return;
    };
    let _ = f.set_times(std::fs::FileTimes::new().set_modified(mtime));
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
pub(crate) async fn stream_copy_file(
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
    // 로컬끼리는 큰 청크 — 네트워크 왕복이 없으니 청크당 blocking 풀 왕복만 줄이면 된다.
    let local = both_local(src_fs, dst_fs);
    let mut buf = vec![0u8; if local { LOCAL_CHUNK } else { RELAY_CHUNK }];
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
    // 로컬→로컬은 원본 수정시각 보존 — 네이티브 경로(native_copy_file)와 동일하게.
    if local {
        let (from, to) = (src.to_path_buf(), part.clone());
        let _ = tokio::task::spawn_blocking(move || copy_mtime(&from, &to)).await;
    }
    // 완성 — .part 를 최종 이름으로 교체.
    finalize_part(dst_fs, &part, dst).await
}

/// `.part` 임시본을 최종 `dst` 로 교체. rename 이 기존 dst 를 못 덮는 경우(SFTP rename
/// 은 기존 파일에 실패 가능) dst 를 `.duet-old` 백업으로 비켜둔 뒤 교체하고 백업을 제거한다.
/// 어느 순간에도 dst 또는 백업 중 하나가 항상 존재 — 기존의 `remove(dst)→rename` 사이
/// 크래시로 인한 영구 데이터 손실 윈도우를 제거한다.
async fn finalize_part(
    dst_fs: &dyn FileSystem,
    part: &std::path::Path,
    dst: &std::path::Path,
) -> Result<(), DuetError> {
    if let Err(e) = dst_fs.rename(part, dst).await {
        if dst_fs.metadata(dst).await.is_ok() {
            let backup = {
                let mut s = dst.as_os_str().to_os_string();
                s.push(".duet-old");
                std::path::PathBuf::from(s)
            };
            dst_fs.rename(dst, &backup).await?; // dst → 백업 (원본 보존)
            dst_fs.rename(part, dst).await?; // part → dst
            let _ = dst_fs.remove(&backup).await; // 백업 정리 (실패는 비치명)
        } else {
            return Err(e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{finalize_part, posix_join, FileSystem};
    use crate::types::{DuetError, Entry, EntryKind, EntryMeta, SourceId, TrashLocation};
    use async_trait::async_trait;
    use std::path::Path;
    use std::pin::Pin;

    #[test]
    fn posix_join_preserves_name_backslash_and_uses_forward_slash() {
        // 일반 결합 — 항상 `/`.
        assert_eq!(
            posix_join(Path::new("/home/u"), "doc.txt")
                .to_str()
                .unwrap(),
            "/home/u/doc.txt"
        );
        // 끝 `/` 중복 방지.
        assert_eq!(
            posix_join(Path::new("/home/u/"), "doc.txt")
                .to_str()
                .unwrap(),
            "/home/u/doc.txt"
        );
        // 루트.
        assert_eq!(posix_join(Path::new("/"), "x").to_str().unwrap(), "/x");
        // 핵심: 이름의 `\` 는 구분자가 아니라 파일명 일부 — 그대로 보존(리눅스 파일명).
        assert_eq!(
            posix_join(Path::new("/home/u"), "weird\\name.txt")
                .to_str()
                .unwrap(),
            "/home/u/weird\\name.txt"
        );
    }
    use std::sync::Mutex;

    /// 호출 순서를 기록하는 mock — finalize_part 의 rename/remove 시퀀스 검증용.
    #[derive(Default)]
    struct RecordingFs {
        calls: Mutex<Vec<String>>,
        rename_count: Mutex<u32>,
        /// 첫 rename(part→dst) 을 실패시켜 SFTP "교체 불가" 를 흉내.
        fail_first_rename: bool,
    }

    #[async_trait]
    impl FileSystem for RecordingFs {
        fn source_id(&self) -> SourceId {
            SourceId::Local
        }
        async fn list(&self, _p: &Path) -> Result<Vec<Entry>, DuetError> {
            unimplemented!()
        }
        async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("metadata({})", p.display()));
            Ok(EntryMeta {
                kind: EntryKind::File,
                size: Some(1),
                modified_ms: None,
                permissions: None,
            })
        }
        async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("rename({},{})", from.display(), to.display()));
            let mut n = self.rename_count.lock().unwrap();
            *n += 1;
            if *n == 1 && self.fail_first_rename {
                Err(DuetError::Ssh("sftp: failure (cannot replace)".into()))
            } else {
                Ok(())
            }
        }
        async fn mkdir(&self, _p: &Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn trash(&self, _p: &Path, _b: &str) -> Result<TrashLocation, DuetError> {
            unimplemented!()
        }
        async fn remove(&self, p: &Path) -> Result<(), DuetError> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("remove({})", p.display()));
            Ok(())
        }
        async fn restore_from_trash(&self, _l: &TrashLocation, _o: &Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn read_full(&self, _p: &Path) -> Result<Vec<u8>, DuetError> {
            unimplemented!()
        }
        async fn write_full(&self, _p: &Path, _b: &[u8]) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn open_read(
            &self,
            _p: &Path,
            _o: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            unimplemented!()
        }
        async fn open_write(
            &self,
            _p: &Path,
            _o: u64,
        ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            unimplemented!()
        }
    }

    #[tokio::test]
    async fn finalize_uses_backup_swap_not_destructive_remove() {
        let fs = RecordingFs {
            fail_first_rename: true,
            ..Default::default()
        };
        finalize_part(&fs, Path::new("/d/f.duet-part"), Path::new("/d/f"))
            .await
            .unwrap();
        let calls = fs.calls.lock().unwrap().clone();
        assert_eq!(
            calls,
            vec![
                "rename(/d/f.duet-part,/d/f)".to_string(), // 첫 시도 실패
                "metadata(/d/f)".to_string(),              // dst 존재 확인
                "rename(/d/f,/d/f.duet-old)".to_string(),  // dst → 백업
                "rename(/d/f.duet-part,/d/f)".to_string(), // part → dst
                "remove(/d/f.duet-old)".to_string(),       // 백업 정리
            ]
        );
        // 핵심: dst 자체가 백업 없이 remove 되지 않음 (데이터 손실 윈도우 없음).
        assert!(!calls.iter().any(|c| c == "remove(/d/f)"));
    }

    #[tokio::test]
    async fn finalize_happy_path_single_rename() {
        let fs = RecordingFs::default(); // 첫 rename 성공
        finalize_part(&fs, Path::new("/d/f.duet-part"), Path::new("/d/f"))
            .await
            .unwrap();
        assert_eq!(*fs.rename_count.lock().unwrap(), 1);
        assert!(!fs
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.starts_with("remove")));
    }
}
