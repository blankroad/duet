//! SSH 통합 — 연결/인증.
//!
//! 게이트: `DUET_SSH_IT=1` + `#[ignore]`. 실행은 `scripts/ssh-it.sh`.

mod ssh_common;

use duet_lib::ssh::connection;
use duet_lib::types::DuetError;
use std::net::{IpAddr, Ipv4Addr};

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn connect_password_captures_peer_ip() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    let sess = ssh_common::connect_password(&host).await;

    // getpeername 이 동작해 host_ip 가 unspecified(0.0.0.0) 가 아니어야 한다.
    match &sess.source {
        duet_lib::types::SourceId::Ssh { host_ip, .. } => {
            assert_ne!(
                *host_ip,
                IpAddr::V4(Ipv4Addr::UNSPECIFIED),
                "host_ip 미캡처"
            );
        }
        _ => panic!("expected SourceId::Ssh"),
    }

    // 살아있는 세션에서 간단한 명령이 돌아야 한다.
    let whoami = ssh_common::stdout_str(&sess.conn, "whoami").await;
    assert_eq!(whoami, host.user);
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn connect_key_auth() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    if host.key.is_none() {
        eprintln!("[ssh-it] DUET_SSH_IT_KEY 미설정 — 키 인증 테스트 skip");
        return;
    }
    let sess = ssh_common::connect_key(&host).await;
    let whoami = ssh_common::stdout_str(&sess.conn, "whoami").await;
    assert_eq!(whoami, host.user);
}

#[tokio::test]
#[ignore = "docker sshd 필요 — scripts/ssh-it.sh"]
async fn connect_wrong_password_is_auth_failed() {
    if ssh_common::skip_if_disabled() {
        return;
    }
    let host = ssh_common::Host::from_env();
    // SshSession 은 Debug 가 아니므로 Ok 값을 버려 Result<(), _> 로 변환 후 검사.
    let res =
        connection::connect_with_password(&host.host, host.port, &host.user, "definitely-wrong")
            .await
            .map(|_| ());
    assert!(
        matches!(res, Err(DuetError::AuthFailed)),
        "expected AuthFailed, got {res:?}"
    );
}
