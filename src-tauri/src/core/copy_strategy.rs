//! 복사 전략 결정 + path shell escape.
//!
//! `decide(src, dst)` 로 strategy 분기 결정. UI/CopyPlan 에 포함되어
//! 사용자에게 "어떤 경로로 복사할지" 미리 표시.
//!
//! `shell_escape_path` 는 SSH exec 명령 인자를 인용하며 경로 문자는 보존한다.
//! 원격 경로 결합은 fs::posix_path / FileSystem::join 이 담당한다 (CLAUDE.md §7).

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
///
/// same-host 판정은 `host_ip` 동일 + **non-unspecified** 일 때만. `0.0.0.0`/`::`
/// (ProxyJump nested 등에서 DNS 미해석 시 fallback, connection.rs `resolve_target_ip`)
/// 는 서로 다른 백엔드여도 우연히 일치하므로 same-host 에서 제외 → 안전하게 Relay.
/// 실제 파일시스템이 있으면 endpoint(포트·점프 경로)까지 확인하는 `decide_fs`를 쓴다.
pub fn decide(src: &SourceId, dst: &SourceId) -> CopyStrategy {
    match (src, dst) {
        (SourceId::Local, SourceId::Local) => CopyStrategy::LocalToLocal,
        (SourceId::Ssh { host_ip: a, .. }, SourceId::Ssh { host_ip: b, .. })
            if a == b && !a.is_unspecified() =>
        {
            CopyStrategy::SshSameHost
        }
        _ => CopyStrategy::Relay,
    }
}

/// Decide using source IDs, rejecting same-host copy when both known backend
/// endpoints differ. Unknown endpoints retain the source-only decision.
pub fn decide_fs(
    src_fs: &dyn crate::fs::FileSystem,
    src: &SourceId,
    dst_fs: &dyn crate::fs::FileSystem,
    dst: &SourceId,
) -> CopyStrategy {
    let strategy = decide(src, dst);
    if strategy == CopyStrategy::SshSameHost
        && matches!(
            (src_fs.endpoint(), dst_fs.endpoint()),
            (Some(src), Some(dst)) if src != dst
        )
    {
        return CopyStrategy::Relay;
    }
    strategy
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
    // Remote paths are already POSIX; backslashes are literal filename characters.
    let escaped = s.replace('\'', "'\\''");
    Ok(format!("'{escaped}'"))
}

/// 쉘 single-quote escape — 일반 문자열(암호 등)용. 경로와 마찬가지로
/// backslash 를 포함한 원본 문자를 보존하고 NUL 은 거부한다.
pub fn shell_escape_str(s: &str) -> Result<String, DuetError> {
    if s.contains('\0') {
        return Err(DuetError::Io("string contains NUL byte".into()));
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
    fn decide_ssh_unspecified_ip_is_relay() {
        // 0.0.0.0 (DNS 미해석 fallback) 은 서로 다른 백엔드여도 일치하므로 same-host 제외.
        let src = ssh([0, 0, 0, 0], "u", "a");
        let dst = ssh([0, 0, 0, 0], "u", "b");
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

    #[test]
    fn escape_preserves_backslash_in_remote_name() {
        // POSIX 원격 파일명의 backslash 는 인용 뒤에도 그대로여야 한다.
        assert_eq!(
            shell_escape_path(Path::new("/home/u/projects\\app.zip")).unwrap(),
            "'/home/u/projects\\app.zip'"
        );
    }
}

/// fileops 점검 라운드(2026-11-08) 재현 테스트 — lead.
#[cfg(test)]
mod review_fileops_lead {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn ssh(ip: IpAddr, conn_id: &str) -> SourceId {
        SourceId::Ssh {
            connection_id: crate::types::ConnectionId(conn_id.into()),
            host_ip: ip,
            user: "u".into(),
        }
    }

    #[test]
    fn matching_endpoints_allow_different_users_and_unknown_preserves_behavior() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let a = ssh(lo, "a");
        let mut b = ssh(lo, "b");
        if let SourceId::Ssh { user, .. } = &mut b {
            *user = "other".into();
        }
        let mut src_fs = crate::fs::testing::TestFs::new(Path::new("/fixture"));
        let mut dst_fs = crate::fs::testing::TestFs::new(Path::new("/fixture"));
        src_fs.endpoint = Some(crate::types::ServerEndpoint::new(lo, 2222, &[]));
        dst_fs.endpoint = src_fs.endpoint.clone();
        assert_eq!(
            decide_fs(&src_fs, &a, &dst_fs, &b),
            CopyStrategy::SshSameHost
        );
        dst_fs.endpoint = None;
        assert_eq!(
            decide_fs(&src_fs, &a, &dst_fs, &b),
            CopyStrategy::SshSameHost
        );
        assert_eq!(
            decide_fs(&dst_fs, &a, &src_fs, &b),
            CopyStrategy::SshSameHost
        );
    }

    #[test]
    fn different_jump_routes_are_not_same_host() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let a = ssh(lo, "a");
        let b = ssh(lo, "b");
        let mut src_fs = crate::fs::testing::TestFs::new(Path::new("/fixture"));
        let mut dst_fs = crate::fs::testing::TestFs::new(Path::new("/fixture"));
        src_fs.endpoint = Some(crate::types::ServerEndpoint::new(
            lo,
            22,
            &["jump-a".into()],
        ));
        dst_fs.endpoint = Some(crate::types::ServerEndpoint::new(
            lo,
            22,
            &["jump-b".into()],
        ));
        assert_eq!(decide_fs(&src_fs, &a, &dst_fs, &b), CopyStrategy::Relay);
    }

    /// 포트 포워딩/Vagrant/도커처럼 **서로 다른 서버**가 같은 IP(127.0.0.1)의 다른 포트로
    /// 붙는 경우, 두 endpoint 는 같은 호스트가 아니다. 포트 차이를 무시하면
    /// 서버측 `cp/rsync` 가 src 서버 안에 기록하므로 Relay 로 분리해야 한다.
    #[test]
    fn loopback_ip_on_different_connections_is_not_same_host() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let a = ssh(lo, "conn-vm1-port2222");
        let b = ssh(lo, "conn-vm2-port2200");
        let mut src_fs = crate::fs::testing::TestFs::new(Path::new("/fixture"));
        let mut dst_fs = crate::fs::testing::TestFs::new(Path::new("/fixture"));
        src_fs.endpoint = Some(crate::types::ServerEndpoint::new(lo, 2222, &[]));
        dst_fs.endpoint = Some(crate::types::ServerEndpoint::new(lo, 2200, &[]));
        assert_eq!(
            decide_fs(&src_fs, &a, &dst_fs, &b),
            CopyStrategy::Relay,
            "서로 다른 포트의 두 서버(같은 127.0.0.1)를 같은 호스트로 판정"
        );
    }
}
