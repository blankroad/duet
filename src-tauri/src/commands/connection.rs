//! 연결 관련 IPC commands.
//!
//! - `ssh_config_hosts`: `~/.ssh/config` 의 호스트 목록 (Sidebar 표시용)
//! - `connection_open`: 새 SSH 연결 (키파일 → SSH agent fallback;
//!   비밀번호 prompt 단계는 Task 7b 에서 OS-native dialog 추가 예정)
//! - `connection_close`: 연결 종료 + pool 에서 제거
//! - `connection_list`: 활성 연결 목록
//!
//! ## CLAUDE.md §5 (자격증명 보호)
//!
//! - 비밀번호/패스프레이즈는 IPC 로 송수신 절대 X.
//!   현재(MVP-1 Phase D 1차) 는 키파일 / SSH agent 로만 인증; 비밀번호 필요한
//!   호스트는 `AuthFailed` 반환하고 Task 7b 에서 secure prompt 추가.
//! - DTO 에서 identity_files 절대경로 / proxy_jump alias 같은 자격증명 관련
//!   디테일은 노출하지 않음. 표시 + 선택에 필요한 최소 정보만.

use std::sync::Arc;

use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

use crate::services::connection_events::{ConnectionStateChange, ConnectionStateEvent};
use crate::services::connection_pool::{ActiveConnection, ConnectionPool};
use crate::ssh::config::{load_ssh_hosts, SshHostEntry};
use crate::ssh::connection::{connect, SshSession};
use crate::types::{ConnectionId, DuetError};

/// Sidebar 에 표시할 호스트 정보 DTO.
///
/// `identity_files` 경로 같은 디테일은 의도적으로 제외 — 프론트엔드는 표시 +
/// 선택만 하고, 자격증명 경로를 알 필요가 없음.
#[derive(Debug, Clone, Serialize, Type)]
pub struct SshHostEntryDto {
    /// `~/.ssh/config` 의 Host 별칭.
    pub alias: String,
    /// 실제 연결할 호스트명 (Hostname 옵션 또는 alias).
    pub hostname: String,
    pub port: u16,
    pub user: String,
    /// ProxyJump 사용 여부 (UI 에 jump 아이콘 표시용; alias 자체는 노출 X).
    pub has_proxy_jump: bool,
}

impl From<SshHostEntry> for SshHostEntryDto {
    fn from(e: SshHostEntry) -> Self {
        Self {
            has_proxy_jump: !e.proxy_jump.is_empty(),
            alias: e.alias,
            hostname: e.hostname,
            port: e.port,
            user: e.user,
        }
    }
}

/// 활성 연결 정보 DTO.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ConnectionDto {
    pub id: ConnectionId,
    pub alias: String,
    /// 핸드셰이크 시점에 잡은 peer IP (문자열). same-host 판정용.
    pub host_ip: String,
    pub user: String,
}

/// `~/.ssh/config` 의 호스트 목록 반환. 파일이 없으면 빈 Vec.
#[tauri::command]
#[specta::specta]
pub async fn ssh_config_hosts() -> Result<Vec<SshHostEntryDto>, DuetError> {
    let entries = load_ssh_hosts()?;
    Ok(entries.into_iter().map(SshHostEntryDto::from).collect())
}

/// 새 SSH 연결 open + ConnectionPool 등록.
///
/// 인증 시도 순서: identity_files → SSH agent → `AuthFailed` (비밀번호는
/// 후속 Task 7b 의 secure prompt 후 별도 command 로).
///
/// 성공 시:
/// 1. ConnectionPool 에 등록
/// 2. `ConnectionStateEvent { state: Connected }` emit
/// 3. 새 `ConnectionId` 반환
#[tauri::command]
#[specta::specta]
pub async fn connection_open(
    alias: String,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    app: tauri::AppHandle,
) -> Result<ConnectionId, DuetError> {
    let all_hosts = load_ssh_hosts()?;
    let host = all_hosts
        .iter()
        .find(|h| h.alias == alias)
        .cloned()
        .ok_or_else(|| {
            DuetError::ConnectionFailed(format!("alias not found in ssh config: {alias}"))
        })?;

    // 키 → agent fallback. AuthFailed 면 비밀번호 prompt 가 필요한 호스트 —
    // Task 7b 에서 secure prompt 추가 후 connect_with_password 호출 분기.
    let session: SshSession = connect(&host, &all_hosts).await?;

    let id = ConnectionId(format!("{}:{}", host.alias, uuid::Uuid::new_v4()));
    let conn = ActiveConnection {
        id: id.clone(),
        alias: host.alias.clone(),
        host_ip: session.host_ip,
        user: host.user.clone(),
        session: Some(tokio::sync::Mutex::new(session.handle)),
    };
    let host_ip = session.host_ip;
    pool.insert(conn).await;

    // emit 실패는 non-fatal — 연결 자체는 성공했으므로 Ok 로 반환.
    let _ = ConnectionStateEvent {
        id: id.clone(),
        alias: host.alias.clone(),
        host_ip: host_ip.to_string(),
        user: host.user.clone(),
        state: ConnectionStateChange::Connected,
    }
    .emit(&app);

    Ok(id)
}

/// 연결 종료 + ConnectionPool 에서 제거.
///
/// SSH disconnect 패킷 송신은 best-effort — 이미 끊긴 연결이라도 pool 정리는
/// 진행. id 가 pool 에 없어도 에러 아님 (idempotent).
///
/// 종료 후 `ConnectionStateEvent { state: Disconnected }` emit.
#[tauri::command]
#[specta::specta]
pub async fn connection_close(
    id: ConnectionId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    app: tauri::AppHandle,
) -> Result<(), DuetError> {
    let snapshot = pool.get(&id).await.ok();
    if let Some(conn) = snapshot.as_ref() {
        if let Some(session_mutex) = conn.session.as_ref() {
            let handle = session_mutex.lock().await;
            // disconnect 결과는 무시 — 이미 끊겼을 수 있음.
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "user closed", "")
                .await;
        }
    }
    pool.remove(&id).await;

    if let Some(conn) = snapshot {
        let _ = ConnectionStateEvent {
            id: id.clone(),
            alias: conn.alias.clone(),
            host_ip: String::new(),
            user: conn.user.clone(),
            state: ConnectionStateChange::Disconnected,
        }
        .emit(&app);
    }
    Ok(())
}

/// 활성 연결 목록 반환.
#[tauri::command]
#[specta::specta]
pub async fn connection_list(
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<Vec<ConnectionDto>, DuetError> {
    let active = pool.list().await;
    Ok(active
        .into_iter()
        .map(|c| ConnectionDto {
            id: c.id.clone(),
            alias: c.alias.clone(),
            host_ip: c.host_ip.to_string(),
            user: c.user.clone(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::config::SshHostEntry;
    use std::path::PathBuf;

    fn mk_entry(alias: &str, with_jump: bool) -> SshHostEntry {
        SshHostEntry {
            alias: alias.into(),
            hostname: format!("{alias}.example.com"),
            port: 22,
            user: "u".into(),
            identity_files: vec![PathBuf::from("/dev/null")],
            proxy_jump: if with_jump {
                vec!["bastion".into()]
            } else {
                vec![]
            },
        }
    }

    /// DTO 변환 — proxy_jump 의 raw alias 는 절대 노출 안 됨, has_proxy_jump 만 노출.
    #[test]
    fn dto_hides_proxy_jump_alias() {
        let with_jump = mk_entry("a", true);
        let dto = SshHostEntryDto::from(with_jump);
        assert_eq!(dto.alias, "a");
        assert!(dto.has_proxy_jump);
        // SshHostEntryDto 에는 proxy_jump 필드 자체가 존재하지 않음 — 컴파일 시 보장.
    }

    #[test]
    fn dto_hides_identity_files() {
        let entry = mk_entry("a", false);
        let dto = SshHostEntryDto::from(entry);
        // identity_files 필드 노출 안 됨 — 컴파일 시 보장.
        assert!(!dto.has_proxy_jump);
        assert_eq!(dto.hostname, "a.example.com");
    }

    /// connection_close 가 존재하지 않는 id 를 idempotent 하게 처리.
    #[tokio::test]
    async fn close_unknown_id_is_idempotent() {
        let pool = ConnectionPool::new();
        // tauri::State 를 mock 하지 않고 ConnectionPool 직접 호출로 검증
        // (command 자체의 무손상은 lib 테스트로 충분 — 핵심은 pool 동작).
        let result = pool.get(&ConnectionId("nope".into())).await;
        assert!(result.is_err());
        pool.remove(&ConnectionId("nope".into())).await; // panic 안 함
    }
}
