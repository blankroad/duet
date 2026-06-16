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
///
/// same-host 판정은 `host_ip` 동일 + **non-unspecified** 일 때만. `0.0.0.0`/`::`
/// (ProxyJump nested 등에서 DNS 미해석 시 fallback, connection.rs `resolve_target_ip`)
/// 는 서로 다른 백엔드여도 우연히 일치하므로 same-host 에서 제외 → 안전하게 Relay.
/// (포트만 다른 동일-IP 컨테이너 구분은 SourceId 에 port 부재 — 후속 과제.)
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
    // §7: 원격 exec 경로는 항상 POSIX. Windows 클라이언트의 PathBuf 는 `\` 구분자를
    // 쓰므로 `/` 로 정규화한다. 안 하면 원격 리눅스가 `\` 를 디렉토리 구분자가 아닌
    // 파일명 문자로 취급해 경로가 깨진다 (목적지 폴더가 파일명 prefix 로 붙는 사고).
    let s = s.replace('\\', "/");
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
    fn escape_normalizes_windows_separator() {
        // §7 회귀: Windows 클라이언트의 PathBuf 가 끼워넣은 `\` 를 원격 POSIX `/` 로.
        // (수정 전엔 `'/home/u/projects\app.zip'` 가 나와 원격에서 경로가 깨졌음.)
        assert_eq!(
            shell_escape_path(Path::new("/home/u/projects\\app.zip")).unwrap(),
            "'/home/u/projects/app.zip'"
        );
    }
}
