//! SSH/SFTP 파일시스템 구현.
//!
//! `ConnectionPool` 의 `ActiveConnection` 을 받아 SFTP 채널을 매번 새로 열고
//! `read_dir` 한다. 채널 캐시는 후속 단계 (Task 12 fs:changed 폴링과 함께
//! 검토 — 캐시가 폴링 부하 줄여줌).
//!
//! ## CLAUDE.md §7 (path)
//!
//! 원격 경로는 항상 POSIX (Unix-style). `Path::to_str` 가 None 이면 비-UTF8
//! 로컬 경로 — SFTP wire format 은 String 이므로 거부.

use crate::fs::FileSystem;
use crate::services::connection_pool::ActiveConnection;
use crate::types::{DuetError, Entry, EntryKind, SourceId};
use async_trait::async_trait;
use std::path::Path;
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
}

#[async_trait]
impl FileSystem for SshFs {
    fn source_id(&self) -> SourceId {
        self.conn.source_id()
    }

    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        let session_mutex = self.conn.session.as_ref().ok_or_else(|| {
            DuetError::ConnectionFailed("connection has no live session (test stub?)".into())
        })?;

        // Session 락은 채널 open 동안만 잡고 즉시 해제 — 동일 connection 위
        // 다른 SFTP 요청과 직렬화 부담 줄임.
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

        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| DuetError::Ssh(format!("sftp init: {e}")))?;

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
            // SFTP 서버는 종종 "." / ".." 도 반환 — LocalFs 와 동작 일치시키기 위해 skip.
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
