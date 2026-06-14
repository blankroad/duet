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
}

#[async_trait]
impl FileSystem for SshFs {
    fn source_id(&self) -> SourceId {
        self.conn.source_id()
    }

    async fn metadata(&self, path: &Path) -> Result<crate::types::EntryMeta, DuetError> {
        let sftp = self.open_sftp().await?;
        let path_str = path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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
        let from_s = from
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 from".into()))?;
        let to_s = to
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 to".into()))?;
        sftp.rename(from_s.to_string(), to_s.to_string())
            .await
            .map_err(|e| map_sftp_error(e, from_s))
    }

    async fn mkdir(&self, path: &Path) -> Result<(), DuetError> {
        let sftp = self.open_sftp().await?;
        let path_str = path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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
        let abs_str = abs_path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
        let target_str = target
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 trash path".into()))?;
        sftp.rename(abs_str.to_string(), target_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, abs_str))?;

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
        let original_str = original_path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 original path".into()))?;
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
        let trash_str = trash_path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 trash path".into()))?;
        sftp.rename(trash_str.to_string(), original_str.to_string())
            .await
            .map_err(|e| map_sftp_error(e, trash_str))
    }

    async fn read_full(&self, path: &Path) -> Result<Vec<u8>, DuetError> {
        use tokio::io::AsyncReadExt;
        let sftp = self.open_sftp().await?;
        let path_str = path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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
        let path_str = path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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

    async fn write_full(&self, path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
        use tokio::io::AsyncWriteExt;
        let sftp = self.open_sftp().await?;
        let path_str = path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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

    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        let sftp = self.open_sftp().await?;
        let path_str = path
            .to_str()
            .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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
    let path_str = path
        .to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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
    let path_str = path
        .to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
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
