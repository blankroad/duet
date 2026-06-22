//! SSH/SFTP 파일시스템 구현.
//!
//! `ConnectionPool` 의 `ActiveConnection` 을 받아 SFTP 채널을 매번 새로 열고
//! 작업한다. 채널 캐시는 후속 단계 (fs:changed 폴링과 함께 검토 — 캐시가
//! 폴링 부하 줄여줌).
//!
//! ## CLAUDE.md §7 (path)
//!
//! 원격 경로는 항상 POSIX (Unix-style). `Path::to_str` 가 None 이면 비-UTF8
//! 로컬 경로 — SFTP wire format 은 String 이므로 거부.
//!
//! ## CLAUDE.md §3 (영구 삭제)
//!
//! `remove` 는 영구 삭제 (재귀 rm). `core/ops` 의 PermanentDelete 만 호출.
//! 일반 코드에서 직접 호출 금지 — `trash` 사용.

use crate::fs::FileSystem;
use crate::services::connection_pool::ActiveConnection;
use crate::types::{DuetError, Entry, EntryKind, SourceId};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// SFTP 기반 `FileSystem` 구현.
pub struct SshFs {
    conn: Arc<ActiveConnection>,
}

impl SshFs {
    /// 활성 연결을 받아 새 SFTP-backed `FileSystem` 인스턴스 생성.
    pub fn new(conn: Arc<ActiveConnection>) -> Self {
        Self { conn }
    }

    /// 원격 사용자 home 디렉토리 절대경로 (SFTP `canonicalize(".")`).
    /// 연결 직후 시작 위치로 사용 — `/` 권한 없는 호스트 일반적이라 home 으로.
    pub async fn home(&self) -> Result<PathBuf, DuetError> {
        let sftp = self.open_sftp().await?;
        remote_home(&sftp).await
    }

    /// 활성 connection 위에 SFTP 채널 새로 열고 SftpSession 반환.
    /// 매 호출마다 새 채널 — 캐시는 후속.
    async fn open_sftp(&self) -> Result<russh_sftp::client::SftpSession, DuetError> {
        let session_mutex = self.conn.session.as_ref().ok_or_else(|| {
            DuetError::ConnectionFailed("connection has no live session (test stub?)".into())
        })?;
        let channel = {
            let handle = session_mutex.lock().await;
            let ch = handle
                .channel_open_session()
                .await
                .map_err(|e| DuetError::Ssh(format!("open session: {e}")))?;
            ch.request_subsystem(true, "sftp")
                .await
                .map_err(|e| DuetError::Ssh(format!("sftp subsystem: {e}")))?;
            ch
        };
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp init: {e}")))
    }

    /// 원격 호스트 내 이동 — atomic `rename` 우선, 실패(EXDEV: src 와 dst 가 다른
    /// 파일시스템) 시 서버측 `cp -a` 복사 후 원본 SFTP 제거.
    ///
    /// trash(mv)/restore 가 cross-mount 에서도 동작하게 하는 폴백. §3 준수: 원본
    /// 제거는 SFTP recursive remove (시스템 `rm` exec 아님). 복사 성공(exit 0)
    /// 확인 후에만 원본 제거 — 데이터 손실 방지.
    async fn move_within_host(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        from: &Path,
        to: &Path,
    ) -> Result<(), DuetError> {
        let from_s = remote_path_str(from)?;
        let to_s = remote_path_str(to)?;
        match sftp.rename(from_s.clone(), to_s).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                // EXDEV(다른 마운트) 만 cp 폴백 대상. NotFound/PermissionDenied 는
                // cross-device 가 아니므로 그대로 전파 — 잘못된 cp+삭제 방지.
                let mapped = map_sftp_error(e, &from_s);
                if !should_cp_fallback(&mapped) {
                    return Err(mapped);
                }
            }
        }
        // cross-device 추정 — mv 처럼 cp -a 후 원본 제거.
        self.exec_cp(from, to).await?;
        Box::pin(remove_recursive(sftp, from)).await
    }

    /// 서버측 `cp -a from to` (russh exec — 같은 호스트라 네트워크 왕복 없음, §9).
    async fn exec_cp(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
        let session =
            self.conn.session.as_ref().ok_or_else(|| {
                DuetError::ConnectionFailed("connection has no live session".into())
            })?;
        let cmd = format!(
            "cp -a -- {} {}",
            posix_shell_quote(&remote_path_str(from)?)?,
            posix_shell_quote(&remote_path_str(to)?)?
        );
        let out = {
            let handle = session.lock().await;
            crate::ssh::remote_exec::exec(&handle, &cmd).await?
        };
        if out.exit_status == 0 {
            Ok(())
        } else {
            Err(DuetError::Ssh(format!(
                "trash cp failed (exit {}): {}",
                out.exit_status,
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }
}

#[async_trait]
impl FileSystem for SshFs {
    fn source_id(&self) -> SourceId {
        self.conn.source_id()
    }

    /// 원격 총 크기 — `du -sb`(서버측, 라운드트립 1회)로 stat 폭주 회피. du 실패 시
    /// 기본 재귀(list+metadata) 폴백 안 하고 0 반환(=총량 미상, 진행률은 indeterminate).
    async fn dir_size(&self, path: &Path) -> Result<u64, DuetError> {
        let session = match self.conn.session.as_ref() {
            Some(s) => s,
            None => return Ok(0),
        };
        let p = match remote_path_str(path).and_then(|s| posix_shell_quote(&s)) {
            Ok(q) => q,
            Err(_) => return Ok(0),
        };
        // -s 합계, -b 바이트(apparent X — 실제 블록 아님; GNU du). BusyBox 는 -b 미지원일
        // 수 있어 실패하면 0(미상). LC_ALL=C 로 출력 안정화.
        let cmd = format!("LC_ALL=C du -sb -- {p}");
        let out = {
            let handle = session.lock().await;
            match crate::ssh::remote_exec::exec(&handle, &cmd).await {
                Ok(o) => o,
                Err(_) => return Ok(0),
            }
        };
        if out.exit_status != 0 {
            return Ok(0);
        }
        // 출력: "<bytes>\t<path>" — 첫 토큰이 바이트.
        let s = String::from_utf8_lossy(&out.stdout);
        Ok(s.split_whitespace()
            .next()
            .and_then(|t| t.parse::<u64>().ok())
            .unwrap_or(0))
    }

    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError> {
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        let meta = sftp
            .metadata(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        let kind = if meta.is_dir() {
            crate::types::EntryKind::Dir
        } else if meta.is_regular() {
            crate::types::EntryKind::File
        } else if meta.is_symlink() {
            crate::types::EntryKind::Symlink
        } else {
            crate::types::EntryKind::Other
        };
        Ok(crate::types::EntryMeta {
            kind,
            size: meta.size,
            modified_ms: meta.mtime.map(|t| i64::from(t) * 1000),
            permissions: meta.permissions.map(|p| p & 0o777),
        })
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<(), DuetError> {
        let sftp = self.open_sftp().await?;
        let from_owned = remote_path_str(from)?;
        let from_s = from_owned.as_str();
        let to_owned = remote_path_str(to)?;
        let to_s = to_owned.as_str();
        sftp.rename(from_s.to_string(), to_s.to_string())
            .await
            .map_err(|e| map_sftp_error(e, from_s))
    }

    async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        sftp.create_dir(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))
    }

    async fn trash(
        &self,
        path: &Path,
        batch_id: &str,
    ) -> Result<crate::types::TrashLocation, DuetError> {
        let sftp = self.open_sftp().await?;
        let home = remote_home(&sftp).await?;
        let trash_base = crate::services::trash::remote_trash_base(&home);

        // 절대경로 보장 — 상대경로면 home 기준으로 정규화 (사용자 입력 방어)
        let abs_path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            home.join(path)
        };

        let target =
            crate::services::trash::remote_trash_path_for(&trash_base, batch_id, &abs_path);
        // target 의 parent 까지 mkdir
        if let Some(parent) = target.parent() {
            sftp_mkdir_all(&sftp, parent).await?;
        }
        // atomic rename 우선, src 와 trash 가 다른 파일시스템(EXDEV)이면 cp+remove 폴백.
        self.move_within_host(&sftp, &abs_path, &target).await?;

        Ok(crate::types::TrashLocation::Remote { trash_path: target })
    }

    async fn remove(&self, path: &Path) -> Result<(), DuetError> {
        let sftp = self.open_sftp().await?;
        Box::pin(remove_recursive(&sftp, path)).await
    }

    async fn restore_from_trash(
        &self,
        location: &crate::types::TrashLocation,
        original_path: &Path,
    ) -> Result<(), DuetError> {
        let crate::types::TrashLocation::Remote { trash_path } = location else {
            return Err(DuetError::Io(
                "restore_from_trash on ssh fs given non-remote location".into(),
            ));
        };
        let sftp = self.open_sftp().await?;
        let original_owned = remote_path_str(original_path)?;
        let original_str = original_owned.as_str();
        // 복원 대상 자리에 이미 있으면 명시 에러
        if sftp.metadata(original_str.to_string()).await.is_ok() {
            return Err(DuetError::Io(format!(
                "restore target exists: {original_str}"
            )));
        }
        // 부모 dir 이 사라졌을 수 있음 — mkdir_all
        if let Some(parent) = original_path.parent() {
            sftp_mkdir_all(&sftp, parent).await?;
        }
        self.move_within_host(&sftp, trash_path, original_path)
            .await
    }

    async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError> {
        use tokio::io::AsyncReadExt;
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        let mut file = sftp
            .open(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp read: {e}")))?;
        Ok(buf)
    }

    async fn read_head(&self, path: &Path, max: usize) -> Result<(Vec<u8>, bool), DuetError> {
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        let mut file = sftp
            .open(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        let mut buf = vec![0u8; max.saturating_add(1)];
        let n = crate::fs::read_upto(&mut file, &mut buf)
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp read: {e}")))?;
        let truncated = n > max;
        buf.truncate(n.min(max));
        Ok((buf, truncated))
    }

    async fn read_range(&self, path: &Path, offset: u64, len: usize) -> Result<Vec<u8>, DuetError> {
        use tokio::io::AsyncSeekExt;
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        let mut file = sftp
            .open(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        // SeekFrom::Start 는 SFTP 에서 저렴 (offset 지정 read). End 는 비싸므로 회피.
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp seek: {e}")))?;
        let mut buf = vec![0u8; len];
        let n = crate::fs::read_upto(&mut file, &mut buf)
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp read: {e}")))?;
        buf.truncate(n);
        Ok(buf)
    }

    async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
        use tokio::io::AsyncWriteExt;
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        let mut file = sftp
            .create(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        file.write_all(bytes)
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp write: {e}")))?;
        file.shutdown()
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp close: {e}")))?;
        Ok(())
    }

    async fn open_read(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        use tokio::io::AsyncSeekExt;
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        // File 은 Arc<RawSftpSession> 를 자체 보유 — sftp 로컬 var 가 drop 돼도 채널 유지.
        let mut file = sftp
            .open(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        if offset > 0 {
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| DuetError::Ssh(format!("sftp seek: {e}")))?;
        }
        Ok(Box::pin(file))
    }

    async fn open_write(
        &self,
        path: &Path,
        offset: u64,
    ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncSeekExt;
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        // offset==0: WRITE|CREATE|TRUNCATE (create 와 동일). offset>0: 이어쓰기 위해
        // TRUNCATE 없이 열고 seek.
        let flags = if offset == 0 {
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
        } else {
            OpenFlags::WRITE | OpenFlags::CREATE
        };
        let mut file = sftp
            .open_with_flags(path_str.to_string(), flags)
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        if offset > 0 {
            file.seek(std::io::SeekFrom::Start(offset))
                .await
                .map_err(|e| DuetError::Ssh(format!("sftp seek: {e}")))?;
        }
        Ok(Box::pin(file))
    }

    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        let sftp = self.open_sftp().await?;
        let owned = remote_path_str(path)?;
        let path_str = owned.as_str();
        let read_dir = sftp
            .read_dir(path_str)
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        let mut entries = Vec::new();
        for ent in read_dir {
            let name = ent.file_name();
            // SFTP 서버는 종종 "." / ".." 도 반환 — LocalFs 와 동작 일치.
            if name == "." || name == ".." {
                continue;
            }
            let meta = ent.metadata();
            let kind = if meta.is_dir() {
                EntryKind::Dir
            } else if meta.is_regular() {
                EntryKind::File
            } else if meta.is_symlink() {
                EntryKind::Symlink
            } else {
                EntryKind::Other
            };
            let hidden = name.starts_with('.');
            entries.push(Entry {
                name,
                kind,
                size: meta.size,
                // mtime: u32 초 단위 → ms 단위 i64 (JS Date 호환)
                modified_ms: meta.mtime.map(|t| i64::from(t) * 1000),
                permissions: meta.permissions.map(|p| p & 0o777),
                hidden,
            });
        }
        Ok(entries)
    }
}

/// 로컬 `Path` → 원격(POSIX) 경로 문자열.
///
/// CLAUDE.md §7: 원격 경로는 항상 POSIX. Windows 클라이언트의 `PathBuf` 는 `\`
/// 구분자를 쓰므로 `/` 로 정규화한다. 안 하면 원격 리눅스가 `\` 를 디렉토리
/// 구분자가 아닌 파일명 문자로 취급해, 복사/삭제 대상 경로가 엉뚱한 곳(home 등)
/// 에서 깨진다. `to_str` 가 None 이면 비-UTF8 로컬 경로 — SFTP wire format(String) 거부.
fn remote_path_str(path: &Path) -> Result<String, DuetError> {
    let s = path
        .to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
    Ok(s.replace('\\', "/"))
}

/// POSIX shell single-quote escape (exec 인자 안전화). NUL 은 거부.
///
/// `core::copy_strategy::shell_escape_path` 와 동일 로직 — §2(fs→core 역방향
/// import 금지) 회피 위해 fs 레이어에 인라인.
fn posix_shell_quote(s: &str) -> Result<String, DuetError> {
    if s.contains('\0') {
        return Err(DuetError::Io("path contains NUL byte".into()));
    }
    Ok(format!("'{}'", s.replace('\'', "'\\''")))
}

/// 원격 사용자의 home 디렉토리 절대경로. SFTP `canonicalize(".")` 결과.
async fn remote_home(sftp: &russh_sftp::client::SftpSession) -> Result<PathBuf, DuetError> {
    let home = sftp
        .canonicalize(".".to_string())
        .await
        .map_err(|e| DuetError::Ssh(format!("canonicalize home: {e}")))?;
    Ok(PathBuf::from(home))
}

/// 재귀 mkdir — 이미 있는 dir 은 OK, 없는 부모들 차례로 생성.
async fn sftp_mkdir_all(
    sftp: &russh_sftp::client::SftpSession,
    path: &Path,
) -> Result<(), DuetError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && parent != Path::new("/") {
            Box::pin(sftp_mkdir_all(sftp, parent)).await?;
        }
    }
    let owned = remote_path_str(path)?;
    let path_str = owned.as_str();
    // 이미 있으면 idempotent.
    if sftp.metadata(path_str.to_string()).await.is_ok() {
        return Ok(());
    }
    sftp.create_dir(path_str.to_string())
        .await
        .map_err(|e| map_sftp_error(e, path_str))
}

/// 디렉토리는 재귀, 파일/심볼릭 링크는 직접.
async fn remove_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: &Path,
) -> Result<(), DuetError> {
    let owned = remote_path_str(path)?;
    let path_str = owned.as_str();
    let meta = sftp
        .metadata(path_str.to_string())
        .await
        .map_err(|e| map_sftp_error(e, path_str))?;
    if meta.is_dir() {
        let children = sftp
            .read_dir(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))?;
        for child in children {
            let name = child.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_path = path.join(&name);
            Box::pin(remove_recursive(sftp, &child_path)).await?;
        }
        sftp.remove_dir(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))
    } else {
        sftp.remove_file(path_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, path_str))
    }
}

/// SFTP 에러 → DuetError 매핑.
///
/// `NoSuchFile` / `PermissionDenied` 는 LocalFs 와 동일한 의미로 매핑하고,
/// 나머지는 `Ssh` 로 감싸서 노출.
fn map_sftp_error(e: russh_sftp::client::error::Error, path: &str) -> DuetError {
    use russh_sftp::client::error::Error as SftpErr;
    use russh_sftp::protocol::StatusCode;
    match e {
        SftpErr::Status(ref s) if s.status_code == StatusCode::NoSuchFile => {
            DuetError::NotFound(path.to_string())
        }
        SftpErr::Status(ref s) if s.status_code == StatusCode::PermissionDenied => {
            DuetError::PermissionDenied(path.to_string())
        }
        other => DuetError::Ssh(format!("sftp: {other}")),
    }
}

/// rename 실패를 cp+remove 폴백으로 처리할지 판정.
///
/// SFTP 프로토콜은 cross-device(EXDEV)를 generic `FAILURE` 로만 보고해 콕 집어
/// 구분할 수 없다. 대신 *명백히* cross-device 가 아닌 경우(NotFound/PermissionDenied)
/// 를 제외하고, 나머지(generic failure = EXDEV 포함)만 폴백한다. 권한오류 등을
/// cp+삭제로 보내 엉뚱한 동작/원본 위협하는 일을 차단한다.
fn should_cp_fallback(err: &DuetError) -> bool {
    !matches!(err, DuetError::NotFound(_) | DuetError::PermissionDenied(_))
}

#[cfg(test)]
mod tests {
    // 실제 SFTP 통합 테스트는 외부 SSH/SFTP 서버 필요 — docker compose 로 후속.
    // 컴파일 시그니처 + 에러 매핑 단위 테스트만.

    use super::*;

    #[test]
    fn ssh_fs_constructor_compiles() {
        let _ = SshFs::new;
    }

    #[test]
    fn cp_fallback_excludes_classified_errors() {
        // 명백히 cross-device 가 아닌 에러 → 폴백 안 함(전파).
        assert!(!super::should_cp_fallback(&DuetError::PermissionDenied(
            "x".into()
        )));
        assert!(!super::should_cp_fallback(&DuetError::NotFound("x".into())));
        // SFTP generic failure(EXDEV 가 여기로 옴) → cp 폴백.
        assert!(super::should_cp_fallback(&DuetError::Ssh(
            "sftp: failure".into()
        )));
        assert!(super::should_cp_fallback(&DuetError::Io("other".into())));
    }

    #[test]
    fn remote_path_str_normalizes_backslashes() {
        use std::path::Path;
        // §7 회귀: Windows 클라이언트의 PathBuf 가 끼워넣은 `\` → 원격 POSIX `/`.
        // 수정 전엔 `/home/u/projects\app.zip` 가 그대로 SFTP 로 나가, 리눅스가
        // home 에 `projects\app.zip` 라는 이름의 파일을 만들었음.
        assert_eq!(
            super::remote_path_str(Path::new("/home/u/projects\\app.zip")).unwrap(),
            "/home/u/projects/app.zip"
        );
        // 휴지통 base 도 동일 — `/home/u\.duet-trash` → `/home/u/.duet-trash`.
        assert_eq!(
            super::remote_path_str(Path::new("/home/u\\.duet-trash\\b\\home\\u\\f.txt")).unwrap(),
            "/home/u/.duet-trash/b/home/u/f.txt"
        );
        // 정상 POSIX 경로는 변형 없음.
        assert_eq!(
            super::remote_path_str(Path::new("/home/u/a/b")).unwrap(),
            "/home/u/a/b"
        );
    }

    #[test]
    fn posix_shell_quote_escapes_and_normalizes() {
        use std::path::Path;
        assert_eq!(super::posix_shell_quote("/a/b").unwrap(), "'/a/b'");
        // 작은따옴표는 '\'' 로.
        assert_eq!(
            super::posix_shell_quote("/a/it's").unwrap(),
            "'/a/it'\\''s'"
        );
        // NUL 거부.
        assert!(super::posix_shell_quote("/a/\0b").is_err());
        // remote_path_str + quote 조합 — Windows `\` 는 `/` 로 정규화되어 안전.
        let p = super::remote_path_str(Path::new("/mnt/d\\f")).unwrap();
        assert_eq!(super::posix_shell_quote(&p).unwrap(), "'/mnt/d/f'");
    }

    #[test]
    fn map_status_no_such_file() {
        use russh_sftp::client::error::Error as SftpErr;
        use russh_sftp::protocol::{Status, StatusCode};
        let err = SftpErr::Status(Status {
            id: 0,
            status_code: StatusCode::NoSuchFile,
            error_message: "no such file".into(),
            language_tag: "en".into(),
        });
        match super::map_sftp_error(err, "/tmp/missing") {
            DuetError::NotFound(p) => assert_eq!(p, "/tmp/missing"),
            other => panic!("expected NotFound, got: {other:?}"),
        }
    }

    #[test]
    fn map_status_permission_denied() {
        use russh_sftp::client::error::Error as SftpErr;
        use russh_sftp::protocol::{Status, StatusCode};
        let err = SftpErr::Status(Status {
            id: 0,
            status_code: StatusCode::PermissionDenied,
            error_message: "denied".into(),
            language_tag: "en".into(),
        });
        match super::map_sftp_error(err, "/secret") {
            DuetError::PermissionDenied(p) => assert_eq!(p, "/secret"),
            other => panic!("expected PermissionDenied, got: {other:?}"),
        }
    }

    #[test]
    fn map_status_other_falls_back_to_ssh() {
        use russh_sftp::client::error::Error as SftpErr;
        use russh_sftp::protocol::{Status, StatusCode};
        let err = SftpErr::Status(Status {
            id: 0,
            status_code: StatusCode::Failure,
            error_message: "generic failure".into(),
            language_tag: "en".into(),
        });
        match super::map_sftp_error(err, "/x") {
            DuetError::Ssh(_) => {}
            other => panic!("expected Ssh, got: {other:?}"),
        }
    }
}
