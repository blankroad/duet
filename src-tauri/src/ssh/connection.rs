//! russh 기반 SSH 클라이언트 연결.
//!
//! - `connect_with_key`: 키파일 인증으로 새 세션
//! - `connect_with_agent`: SSH agent (`SSH_AUTH_SOCK`) 인증
//! - `connect_with_password`: 비밀번호 인증 (메모리에서만, 로그 출력 없음)
//! - `connect`: 키파일 → agent → AuthFailed 순서로 폴백하는 오케스트레이터
//! - `AcceptAllHandler`: 호스트키 무조건 수락 (MVP-2+ 에서 known_hosts 검증으로 강화)

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

/// SSH agent (`SSH_AUTH_SOCK`) 통한 인증.
///
/// agent 가 보유한 키들로 차례로 시도한다. 모두 거부되거나 agent 자체가 없으면
/// `DuetError::AuthFailed` 반환.
///
/// # CLAUDE.md §5
///
/// agent 로부터 오는 공개키 정보는 인증 프로토콜에서만 사용. 로그에 출력하지 않음.
pub async fn connect_with_agent(
    hostname: &str,
    port: u16,
    user: &str,
) -> Result<SshSession, DuetError> {
    let tcp = TcpStream::connect((hostname, port))
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("{hostname}:{port} — {e}")))?;
    let host_ip = tcp
        .peer_addr()
        .map_err(|e| DuetError::ConnectionFailed(format!("getpeername: {e}")))?
        .ip();

    let mut handle = russh::client::connect_stream(make_config(), tcp, AcceptAllHandler)
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("ssh handshake: {e}")))?;

    // SSH_AUTH_SOCK 가 없거나 agent 가 응답 안 하면 AuthFailed.
    // connect_env() 는 Unix 전용 — Windows 빌드는 cfg(unix) 로 분리.
    #[cfg(not(unix))]
    {
        let _ = handle;
        return Err(DuetError::AuthFailed);
    }

    #[cfg(unix)]
    {
        let mut agent = russh::keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|_| DuetError::AuthFailed)?;

        // 공개키 목록을 먼저 수집 (request_identities 는 &mut self).
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| DuetError::Ssh(format!("agent request_identities: {e}")))?;

        if identities.is_empty() {
            return Err(DuetError::AuthFailed);
        }

        // authenticate_future 는 agent 를 by-value 로 받아 signing 후 돌려줌.
        // 키마다 순환하며 시도; 성공 즉시 반환.
        for ident in identities {
            let (returned_agent, result) = handle.authenticate_future(user, ident, agent).await;
            agent = returned_agent;
            match result {
                Ok(true) => return Ok(SshSession { handle, host_ip }),
                Ok(false) => continue, // 이 키는 거부 — 다음 키
                Err(_) => continue,    // 서명 에러 — 다음 키
            }
        }

        Err(DuetError::AuthFailed)
    }
}

/// 비밀번호 인증.
///
/// **CLAUDE.md §5**: `password` 는 함수 인자로만 받는다. 호출자가 secure prompt 에서
/// 받아 이 함수에 전달해야 함. 이 함수는 `password` 를 어디에도 저장 / 출력하지 않음.
/// russh 라이브러리 내부에서도 wire format 으로만 사용되며 로그에 노출되지 않는다.
pub async fn connect_with_password(
    hostname: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<SshSession, DuetError> {
    let tcp = TcpStream::connect((hostname, port))
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("{hostname}:{port} — {e}")))?;
    let host_ip = tcp
        .peer_addr()
        .map_err(|e| DuetError::ConnectionFailed(format!("getpeername: {e}")))?
        .ip();

    let mut handle = russh::client::connect_stream(make_config(), tcp, AcceptAllHandler)
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("ssh handshake: {e}")))?;

    let auth_ok = handle
        .authenticate_password(user, password)
        .await
        .map_err(|e| {
            // russh 의 Display impl 은 SSH 프로토콜 메시지만 출력 — password 포함 안 됨.
            DuetError::Ssh(format!("password auth: {e}"))
        })?;

    if !auth_ok {
        return Err(DuetError::AuthFailed);
    }
    Ok(SshSession { handle, host_ip })
}

/// 호스트 설정 기반 인증 오케스트레이터.
///
/// 시도 순서: identity_files (passphrase 없이) → SSH agent → `DuetError::AuthFailed`.
///
/// - 네트워크 에러 (`ConnectionFailed`) 는 즉시 반환 — 폴백 없음.
/// - `AuthFailed` 만 다음 메서드로 폴백.
/// - 비밀번호 prompt 는 호출자(`connection_open` command) 가 담당:
///   `AuthFailed` 수신 시 사용자에게 prompt 후 `connect_with_password` 직접 호출.
pub async fn connect(host: &crate::ssh::config::SshHostEntry) -> Result<SshSession, DuetError> {
    // 1. identity_files 를 차례로 시도 (passphrase None — 암호화된 키는 AuthFailed → 다음).
    for key_path in &host.identity_files {
        match connect_with_key(&host.hostname, host.port, &host.user, key_path, None).await {
            Ok(s) => return Ok(s),
            Err(DuetError::AuthFailed) => continue,
            Err(e) => return Err(e), // 네트워크 에러 등 — 즉시 반환
        }
    }

    // 2. SSH agent.
    match connect_with_agent(&host.hostname, host.port, &host.user).await {
        Ok(s) => Ok(s),
        Err(DuetError::AuthFailed) => Err(DuetError::AuthFailed), // 호출자가 password prompt
        Err(e) => Err(e),
    }
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

    /// connect_with_password 시그니처 컴파일 검증.
    #[test]
    fn connect_with_password_compiles() {
        let _: fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = _>>> =
            || Box::pin(super::connect_with_password("localhost", 22, "user", "pw"));
    }

    /// connect_with_agent 시그니처 컴파일 검증.
    #[test]
    fn connect_with_agent_compiles() {
        let _: fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = _>>> =
            || Box::pin(super::connect_with_agent("localhost", 22, "user"));
    }

    /// connect() 오케스트레이터 시그니처 컴파일 검증.
    #[test]
    fn connect_orchestrator_compiles() {
        use crate::ssh::config::SshHostEntry;
        let _: fn(&SshHostEntry) -> std::pin::Pin<Box<dyn std::future::Future<Output = _> + '_>> =
            |h| Box::pin(super::connect(h));
    }
}
