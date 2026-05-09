//! russh 기반 SSH 클라이언트 연결.
//!
//! - `connect_with_key`: 키파일 인증으로 새 세션 (직접 연결)
//! - `connect_with_agent`: SSH agent (`SSH_AUTH_SOCK`) 인증 (직접 연결)
//! - `connect_with_password`: 비밀번호 인증 (메모리에서만, 로그 출력 없음)
//! - `connect`: 키파일 → agent → AuthFailed 폴백 오케스트레이터.
//!   `host.proxy_jump` 가 비어있지 않으면 jump host 통한 nested 세션.
//! - `AcceptAllHandler`: 호스트키 무조건 수락 (MVP-2+ 에서 known_hosts 검증으로 강화)
//!
//! ## ProxyJump (CLAUDE.md §9)
//!
//! 시스템 `ssh -J` 명령을 호출하지 않는다. russh 의 `channel_open_direct_tcpip`
//! 으로 jump host 위에 TCP forwarding 채널을 열고, 그 `ChannelStream` 위에
//! 새 SSH 핸드셰이크를 수행 (nested session). MVP-1 은 1-hop 만 지원;
//! 다중 hop 은 후속 단계에서 재귀 확장.
//!
//! Jump session 의 `Handle` 은 nested 세션이 살아있는 동안 drop 되면 안 됨
//! (채널이 끊김). `SshSession::jump_sessions` 에 보관해서 같이 drop 되도록 유지.

use std::net::{IpAddr, Ipv4Addr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use russh::client::{Config, Handle, Handler};
use russh::keys::key;
use russh::keys::load_secret_key;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use crate::ssh::config::SshHostEntry;
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
///
/// 필드 선언 순서가 곧 drop 순서다 (Rust). `handle` 이 먼저 drop 되어 nested
/// 세션이 깔끔히 닫힌 뒤, `_jump_sessions` 가 drop 되어 jump host 들의 채널이
/// 닫히는 순서를 보장한다 — 반대로 drop 되면 이미 닫힌 채널 위에 disconnect
/// 패킷을 보내려다 에러가 발생할 수 있음.
pub struct SshSession {
    /// russh 세션 핸들. SFTP 채널 개설 등 후속 작업에 사용.
    pub handle: Handle<AcceptAllHandler>,
    /// 핸드셰이크 시점의 peer IP — 같은-호스트 복사 판정용 (SourceId).
    /// ProxyJump 경로에서는 nested 채널이라 `peer_addr` 가 없으므로
    /// 로컬 DNS 에서 best-effort 로 resolve 한 IP. 해석 실패 시 `0.0.0.0`.
    pub host_ip: IpAddr,
    /// ProxyJump 시 거쳐온 jump session 들 (직접 연결이면 빈 Vec).
    /// nested 세션이 사용하는 ChannelStream 의 백엔드라서 살아있어야 한다.
    /// 이 필드는 외부에서 직접 사용 안 됨 — drop 가드 역할만.
    #[allow(dead_code)]
    _jump_sessions: Vec<Handle<AcceptAllHandler>>,
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

    Ok(SshSession {
        handle,
        host_ip,
        _jump_sessions: Vec::new(),
    })
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
                Ok(true) => {
                    return Ok(SshSession {
                        handle,
                        host_ip,
                        _jump_sessions: Vec::new(),
                    });
                }
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
    Ok(SshSession {
        handle,
        host_ip,
        _jump_sessions: Vec::new(),
    })
}

// === auth-on-handle 헬퍼 ===
//
// `connect_with_*` 들의 직접 연결 경로와 `connect_via_jump` 의 nested 경로가
// 같은 인증 로직을 공유하기 위한 내부 헬퍼. 호출자는 이미 SSH 핸드셰이크가
// 끝난 `Handle` 을 가지고 있고, 그 위에서 인증만 수행한다.

/// 키파일로 핸들 인증. 실패 시 `DuetError::AuthFailed`.
///
/// CLAUDE.md §5: passphrase 는 인자로만 받고 어디에도 저장/출력하지 않는다.
async fn auth_publickey_on_handle(
    handle: &mut Handle<AcceptAllHandler>,
    user: &str,
    key_path: &Path,
    passphrase: Option<&str>,
) -> Result<(), DuetError> {
    let secret = load_secret_key(key_path, passphrase).map_err(|_| DuetError::AuthFailed)?;
    let auth_ok = handle
        .authenticate_publickey(user, Arc::new(secret))
        .await
        .map_err(|e| DuetError::Ssh(format!("publickey auth: {e}")))?;
    if !auth_ok {
        return Err(DuetError::AuthFailed);
    }
    Ok(())
}

/// SSH agent 로 핸들 인증.
#[cfg(unix)]
async fn auth_agent_on_handle(
    handle: &mut Handle<AcceptAllHandler>,
    user: &str,
) -> Result<(), DuetError> {
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|_| DuetError::AuthFailed)?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| DuetError::Ssh(format!("agent request_identities: {e}")))?;
    if identities.is_empty() {
        return Err(DuetError::AuthFailed);
    }
    for ident in identities {
        let (returned_agent, result) = handle.authenticate_future(user, ident, agent).await;
        agent = returned_agent;
        if let Ok(true) = result {
            return Ok(());
        }
    }
    Err(DuetError::AuthFailed)
}

#[cfg(not(unix))]
async fn auth_agent_on_handle(
    _handle: &mut Handle<AcceptAllHandler>,
    _user: &str,
) -> Result<(), DuetError> {
    Err(DuetError::AuthFailed)
}

/// 호스트 설정의 키파일들 → SSH agent 순서로 인증 시도.
/// 모두 실패하면 `DuetError::AuthFailed` — 호출자가 비밀번호 prompt 진행.
async fn auth_orchestrated_on_handle(
    handle: &mut Handle<AcceptAllHandler>,
    host: &SshHostEntry,
) -> Result<(), DuetError> {
    for key_path in &host.identity_files {
        match auth_publickey_on_handle(handle, &host.user, key_path, None).await {
            Ok(()) => return Ok(()),
            Err(DuetError::AuthFailed) => continue,
            Err(e) => return Err(e),
        }
    }
    auth_agent_on_handle(handle, &host.user).await
}

/// 임의의 AsyncRead+AsyncWrite 스트림 위에 SSH 핸드셰이크.
///
/// 직접 TCP 든 ProxyJump 의 ChannelStream 이든 동일하게 사용. 핸드셰이크만 하고
/// 인증은 호출자가 별도로 진행 (`auth_orchestrated_on_handle`).
async fn handshake_on_stream<S>(stream: S) -> Result<Handle<AcceptAllHandler>, DuetError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    russh::client::connect_stream(make_config(), stream, AcceptAllHandler)
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("ssh handshake: {e}")))
}

/// 호스트 설정 기반 인증 오케스트레이터 (직접 연결).
///
/// 시도 순서: identity_files → SSH agent → `DuetError::AuthFailed`.
/// 네트워크 에러 (`ConnectionFailed`) 는 즉시 반환 — 폴백 없음.
async fn connect_direct(host: &SshHostEntry) -> Result<SshSession, DuetError> {
    let tcp = TcpStream::connect((host.hostname.as_str(), host.port))
        .await
        .map_err(|e| {
            DuetError::ConnectionFailed(format!("{}:{} — {e}", host.hostname, host.port))
        })?;
    let host_ip = tcp
        .peer_addr()
        .map_err(|e| DuetError::ConnectionFailed(format!("getpeername: {e}")))?
        .ip();

    let mut handle = handshake_on_stream(tcp).await?;
    auth_orchestrated_on_handle(&mut handle, host).await?;

    Ok(SshSession {
        handle,
        host_ip,
        _jump_sessions: Vec::new(),
    })
}

/// ProxyJump (1-hop) 통한 nested 연결.
///
/// 1. jump host 에 직접 연결 (`connect_direct`).
/// 2. jump session 위에서 `channel_open_direct_tcpip(target.hostname, target.port, ...)`.
/// 3. 그 채널을 `into_stream()` 으로 AsyncRead+AsyncWrite 로 변환.
/// 4. 그 스트림 위에 새 SSH 핸드셰이크 (nested) + target 자격증명으로 인증.
///
/// jump session 의 `Handle` 은 nested 세션이 살아있는 동안 유지되어야 하므로
/// 결과 `SshSession::_jump_sessions` 에 보관한다 (drop 가드).
///
/// 다중 hop (`proxy_jump.len() > 1`) 은 현재 미지원 — 명시적으로 에러 반환.
async fn connect_via_jump(
    target: &SshHostEntry,
    all_hosts: &[SshHostEntry],
) -> Result<SshSession, DuetError> {
    if target.proxy_jump.len() > 1 {
        return Err(DuetError::ConnectionFailed(format!(
            "multi-hop ProxyJump (len={}) not yet supported",
            target.proxy_jump.len()
        )));
    }
    let jump_alias = &target.proxy_jump[0];
    let jump_host = all_hosts
        .iter()
        .find(|h| &h.alias == jump_alias)
        .ok_or_else(|| {
            DuetError::ConnectionFailed(format!(
                "ProxyJump alias '{jump_alias}' not found in ssh config"
            ))
        })?;

    // 1. Jump host 직접 연결.
    let jump_session = connect_direct(jump_host).await?;

    // 2. Jump 위에서 target 으로 direct-tcpip 채널 open.
    //    originator 는 관습적으로 127.0.0.1:0 — 서버는 보통 무시.
    let channel = jump_session
        .handle
        .channel_open_direct_tcpip(
            target.hostname.clone(),
            u32::from(target.port),
            "127.0.0.1",
            0,
        )
        .await
        .map_err(|e| {
            DuetError::ConnectionFailed(format!(
                "channel_open_direct_tcpip via {} → {}:{}: {e}",
                jump_host.alias, target.hostname, target.port
            ))
        })?;

    // 3. 채널 → AsyncRead+AsyncWrite 스트림.
    let stream = channel.into_stream();

    // 4. host_ip 는 nested 라 peer_addr 불가 — 로컬 DNS 로 best-effort resolve.
    //    이 IP 는 jump 의 관점이 아닌 클라이언트 관점이므로 부정확할 수 있음.
    //    같은-호스트 판정은 host_ip + connection_id 조합으로 하므로 0.0.0.0 도 동작.
    let host_ip = resolve_target_ip(&target.hostname).await;

    // 5. Nested 핸드셰이크 + target 자격증명으로 인증.
    let mut handle = handshake_on_stream(stream).await.map_err(|e| match e {
        DuetError::ConnectionFailed(msg) => {
            DuetError::ConnectionFailed(format!("nested ssh via {}: {msg}", jump_host.alias))
        }
        other => other,
    })?;
    auth_orchestrated_on_handle(&mut handle, target).await?;

    Ok(SshSession {
        handle,
        host_ip,
        _jump_sessions: vec![jump_session.handle],
    })
}

/// 호스트명 (또는 IP 문자열) 을 IpAddr 로 best-effort 해석. 실패 시 `0.0.0.0`.
async fn resolve_target_ip(hostname: &str) -> IpAddr {
    if let Ok(ip) = hostname.parse::<IpAddr>() {
        return ip;
    }
    match tokio::net::lookup_host((hostname, 0u16)).await {
        Ok(mut addrs) => addrs
            .next()
            .map(|a| a.ip())
            .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
        Err(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
    }
}

/// 호스트 설정 기반 인증 오케스트레이터 (ProxyJump 자동 처리).
///
/// `host.proxy_jump` 가 비어있으면 직접 연결, 아니면 jump 통한 nested 세션.
/// `all_hosts` 는 jump alias resolve 용 — `~/.ssh/config` 전체 엔트리 목록.
///
/// 시도 순서: identity_files (passphrase 없이) → SSH agent → `DuetError::AuthFailed`.
/// `AuthFailed` 시 호출자(`connection_open` command) 가 비밀번호 prompt 후
/// `connect_with_password` 별도 호출.
pub async fn connect(
    host: &SshHostEntry,
    all_hosts: &[SshHostEntry],
) -> Result<SshSession, DuetError> {
    if host.proxy_jump.is_empty() {
        connect_direct(host).await
    } else {
        connect_via_jump(host, all_hosts).await
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

    /// connect() 오케스트레이터 시그니처 컴파일 검증 (host + all_hosts).
    /// 함수 포인터 캐스팅으로 시그니처가 노출되는지만 확인.
    #[test]
    fn connect_orchestrator_compiles() {
        let _ = super::connect;
    }

    /// ProxyJump alias 가 all_hosts 에 없으면 ConnectionFailed (네트워크 호출 전).
    #[tokio::test]
    async fn connect_via_jump_unknown_alias_fails_fast() {
        use crate::ssh::config::SshHostEntry;
        use crate::types::DuetError;

        let target = SshHostEntry {
            alias: "target".into(),
            hostname: "target.example.com".into(),
            port: 22,
            user: "u".into(),
            identity_files: vec![],
            proxy_jump: vec!["nonexistent-bastion".into()],
        };
        let all = vec![target.clone()]; // jump 가 목록에 없음

        let result = super::connect(&target, &all).await;
        match result {
            Err(DuetError::ConnectionFailed(msg)) => {
                assert!(
                    msg.contains("nonexistent-bastion"),
                    "expected jump alias in error, got: {msg}"
                );
            }
            Err(other) => panic!("expected ConnectionFailed, got other err: {other:?}"),
            Ok(_) => panic!("expected ConnectionFailed, got Ok"),
        }
    }

    /// ProxyJump 가 다중 hop 이면 즉시 ConnectionFailed (현재 미지원).
    #[tokio::test]
    async fn connect_via_jump_multi_hop_unsupported() {
        use crate::ssh::config::SshHostEntry;
        use crate::types::DuetError;

        let target = SshHostEntry {
            alias: "target".into(),
            hostname: "target.example.com".into(),
            port: 22,
            user: "u".into(),
            identity_files: vec![],
            proxy_jump: vec!["b1".into(), "b2".into()],
        };
        let all = vec![target.clone()];

        match super::connect(&target, &all).await {
            Err(DuetError::ConnectionFailed(msg)) => {
                assert!(
                    msg.contains("multi-hop"),
                    "expected 'multi-hop' in error, got: {msg}"
                );
            }
            Err(other) => panic!("expected ConnectionFailed for multi-hop, got: {other:?}"),
            Ok(_) => panic!("expected ConnectionFailed for multi-hop, got Ok"),
        }
    }

    /// resolve_target_ip: 리터럴 IP 는 그대로 반환.
    #[tokio::test]
    async fn resolve_target_ip_passes_through_literal() {
        let ip = super::resolve_target_ip("10.20.30.40").await;
        assert_eq!(ip.to_string(), "10.20.30.40");
    }

    /// resolve_target_ip: 해석 불가능한 호스트명은 0.0.0.0 으로 fallback.
    #[tokio::test]
    async fn resolve_target_ip_unresolvable_falls_back_to_zero() {
        // ".invalid" TLD 는 RFC 6761 reserved — DNS 응답 없음.
        let ip = super::resolve_target_ip("definitely-not-a-host.invalid").await;
        assert_eq!(ip.to_string(), "0.0.0.0");
    }
}
