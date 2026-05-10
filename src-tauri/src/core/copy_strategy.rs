//! 복사 전략 결정 + path shell escape.
//!
//! `decide(src, dst)` 로 strategy 분기 결정. UI/CopyPlan 에 포함되어
//! 사용자에게 "어떤 경로로 복사할지" 미리 표시.
//!
//! `shell_escape_path` 는 SSH exec 명령 인자에 path 안전 임베딩
//! (CLAUDE.md §7).

use crate::types::{DuetError, SourceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

/// 복사 전략. UI 에 표시 + backend 분기 결정.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CopyStrategy {
    /// 로컬 ↔ 로컬 (tokio::fs::copy).
    LocalToLocal,
    /// local↔ssh 또는 ssh↔ssh different-host — 본인 PC 거쳐 stream.
    Relay,
    /// 같은 SSH 호스트 (host_ip 일치) — 서버에서 cp/rsync exec.
    SshSameHost,
}

/// SourceId 쌍으로 strategy 결정.
pub fn decide(src: &SourceId, dst: &SourceId) -> CopyStrategy {
    match (src, dst) {
        (SourceId::Local, SourceId::Local) => CopyStrategy::LocalToLocal,
        (SourceId::Ssh { host_ip: a, .. }, SourceId::Ssh { host_ip: b, .. }) if a == b => {
            CopyStrategy::SshSameHost
        }
        _ => CopyStrategy::Relay,
    }
}

/// POSIX shell single-quote escape — exec 명령 인자 안전화.
///
/// path 를 `'...'` 로 감싸고, 안에 있는 `'` 는 `'\''` 로.
/// `\0` (null byte) 가 path 에 있으면 거부 (POSIX 도 허용 안 함).
///
/// 예: `/home/u/it's a test` → `'/home/u/it'\''s a test'`
pub fn shell_escape_path(p: &Path) -> Result<String, DuetError> {
    let s = p
        .to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;
    if s.contains('\0') {
        return Err(DuetError::Io("path contains NUL byte".into()));
    }
    let escaped = s.replace('\'', "'\\''");
    Ok(format!("'{escaped}'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ConnectionId;
    use std::net::{IpAddr, Ipv4Addr};

    fn ssh(ip: [u8; 4], user: &str, conn_id: &str) -> SourceId {
        SourceId::Ssh {
            connection_id: ConnectionId(conn_id.into()),
            host_ip: IpAddr::V4(Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])),
            user: user.into(),
        }
    }

    #[test]
    fn decide_local_to_local() {
        assert_eq!(
            decide(&SourceId::Local, &SourceId::Local),
            CopyStrategy::LocalToLocal
        );
    }

    #[test]
    fn decide_local_to_ssh_is_relay() {
        let dst = ssh([10, 0, 0, 1], "u", "a");
        assert_eq!(decide(&SourceId::Local, &dst), CopyStrategy::Relay);
    }

    #[test]
    fn decide_ssh_to_local_is_relay() {
        let src = ssh([10, 0, 0, 1], "u", "a");
        assert_eq!(decide(&src, &SourceId::Local), CopyStrategy::Relay);
    }

    #[test]
    fn decide_ssh_same_host_same_user() {
        let src = ssh([10, 0, 0, 1], "u", "a");
        let dst = ssh([10, 0, 0, 1], "u", "b");
        assert_eq!(decide(&src, &dst), CopyStrategy::SshSameHost);
    }

    #[test]
    fn decide_ssh_same_host_different_user() {
        let src = ssh([10, 0, 0, 1], "alice", "a");
        let dst = ssh([10, 0, 0, 1], "bob", "b");
        assert_eq!(decide(&src, &dst), CopyStrategy::SshSameHost);
    }

    #[test]
    fn decide_ssh_different_host_is_relay() {
        let src = ssh([10, 0, 0, 1], "u", "a");
        let dst = ssh([10, 0, 0, 2], "u", "b");
        assert_eq!(decide(&src, &dst), CopyStrategy::Relay);
    }

    #[test]
    fn escape_simple_path() {
        assert_eq!(
            shell_escape_path(Path::new("/home/user/file.txt")).unwrap(),
            "'/home/user/file.txt'"
        );
    }

    #[test]
    fn escape_path_with_single_quote() {
        assert_eq!(
            shell_escape_path(Path::new("/home/u/it's a test")).unwrap(),
            "'/home/u/it'\\''s a test'"
        );
    }

    #[test]
    fn escape_path_with_space() {
        assert_eq!(
            shell_escape_path(Path::new("/tmp/foo bar")).unwrap(),
            "'/tmp/foo bar'"
        );
    }

    #[test]
    fn escape_path_with_null_byte_rejected() {
        let p = std::path::PathBuf::from("/tmp/\0bad");
        assert!(shell_escape_path(&p).is_err());
    }
}
