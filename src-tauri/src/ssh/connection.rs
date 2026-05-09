//! russh 기반 SSH 클라이언트 연결.
//!
//! - `connect_with_key`: 키파일 인증으로 새 세션
//! - `AcceptAllHandler`: 호스트키 무조건 수락 (MVP-2+ 에서 known_hosts 검증으로 강화)
//!
//! Agent / password / ProxyJump 인증은 후속 Task.

use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{Config, Handle, Handler};
use russh::keys::key;
use russh::keys::load_secret_key;
use tokio::net::TcpStream;

use crate::types::DuetError;

/// 호스트키를 무조건 수락하는 client handler.
///
/// MVP-1 은 known_hosts 검증 생략 — MVP-2 이상에서 strict 로 강화 예정.
pub struct AcceptAllHandler;

#[async_trait]
impl Handler for AcceptAllHandler {
    type Error = russh::Error;

    /// 서버 공개키를 무조건 수락.
    ///
    /// TODO (MVP-2+): known_hosts 파일 검증으로 교체.
    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 연결 결과. session handle + 핸드셰이크 시점에 잡은 peer IP.
pub struct SshSession {
    /// russh 세션 핸들. SFTP 채널 개설 등 후속 작업에 사용.
    pub handle: Handle<AcceptAllHandler>,
    /// TCP 소켓의 `getpeername()` IP. 같은-호스트 복사 판정용 (SourceId).
    pub host_ip: IpAddr,
}

fn make_config() -> Arc<Config> {
    Arc::new(Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    })
}

/// 키파일로 SSH 연결.
///
/// `passphrase` 가 `None` 이면 키가 암호화되지 않은 경우만 성공.
/// Encrypted key + `None` 이면 `DuetError::AuthFailed` 반환 — 호출자가 prompt 후 재시도.
///
/// # CLAUDE.md §5
///
/// passphrase 는 함수 내에서 절대 로그/Debug 출력 안 함.
/// `russh_keys::load_secret_key` 의 에러도 passphrase 를 포함하지 않음.
pub async fn connect_with_key(
    hostname: &str,
    port: u16,
    user: &str,
    key_path: &Path,
    passphrase: Option<&str>,
) -> Result<SshSession, DuetError> {
    // TCP 소켓을 수동으로 먼저 연결 — peer_addr() 로 host_ip 를 캡처하기 위해.
    let tcp = TcpStream::connect((hostname, port))
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("{hostname}:{port} — {e}")))?;

    let host_ip = tcp
        .peer_addr()
        .map_err(|e| DuetError::ConnectionFailed(format!("getpeername: {e}")))?
        .ip();

    // connect_stream 에 TcpStream 을 직접 전달 — 이미 연결된 소켓 재사용.
    let mut handle = russh::client::connect_stream(make_config(), tcp, AcceptAllHandler)
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("ssh handshake: {e}")))?;

    // 키 로드. passphrase 를 로그에 절대 출력하지 않음 (CLAUDE.md §5).
    let secret = load_secret_key(key_path, passphrase).map_err(|_| DuetError::AuthFailed)?;

    let auth_ok = handle
        .authenticate_publickey(user, Arc::new(secret))
        .await
        .map_err(|e| DuetError::Ssh(format!("publickey auth: {e}")))?;

    if !auth_ok {
        return Err(DuetError::AuthFailed);
    }

    Ok(SshSession { handle, host_ip })
}

#[cfg(test)]
mod tests {
    // 실제 SSH 핸드셰이크 통합 테스트는 외부 SSH 서버 필요.
    // 컴파일 타임 시그니처 검증: connect_with_key 와 AcceptAllHandler 가 노출되는지 확인.

    #[test]
    fn accept_all_handler_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<super::AcceptAllHandler>();
    }

    #[test]
    fn ssh_session_fields_accessible() {
        // SshSession 의 public 필드가 존재하는지 컴파일 수준 검증.
        // (실제 인스턴스 생성은 SSH 서버 없이 불가능하므로 타입 체크만)
        let _: fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = _>>> = || {
            Box::pin(super::connect_with_key(
                "localhost",
                22,
                "user",
                std::path::Path::new("/tmp/key"),
                None,
            ))
        };
    }
}
