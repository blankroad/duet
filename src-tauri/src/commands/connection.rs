//! 연결 관련 IPC commands.
//!
//! - `ssh_config_hosts`: `~/.ssh/config` 의 호스트 목록 (Sidebar 표시용)
//! - `connection_open`: 새 SSH 연결 (키파일 → SSH agent → 비밀번호 fallback)
//! - `connection_close`: 연결 종료 + pool 에서 제거
//! - `connection_list`: 활성 연결 목록
//!
//! ## CLAUDE.md §5 (자격증명 보호) — 2026-05 완화 반영
//!
//! - 인증은 키파일 / SSH agent 우선. 둘 다 실패(`AuthFailed`)하면 frontend
//!   dialog 의 `<input type=password>` 에서 받은 평문 비밀번호를 IPC 인자로
//!   전달받아 마지막 fallback 으로 시도 (§5 완화 조건: component-local state,
//!   호출 직후 clear, store/디스크 영속 X). 이 평문은 backend 메모리에만 잠시
//!   존재하고 사용 직후 `zeroize_string` 으로 best-effort 제거한다.
//! - 비밀번호/패스프레이즈는 `tracing` 로그에 절대 출력 X.
//! - DTO 에서 identity_files 절대경로 / proxy_jump alias 같은 자격증명 관련
//!   디테일은 노출하지 않음. 표시 + 선택에 필요한 최소 정보만.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use specta::Type;
use tauri_specta::Event;

use crate::services::connection_events::{ConnectionStateChange, ConnectionStateEvent};
use crate::services::connection_pool::{ActiveConnection, ConnectionPool};
use crate::services::connection_supervisor::spawn_supervisor;
use crate::ssh::config::{load_ssh_hosts, SshHostEntry};
use crate::ssh::connection::{connect, connect_with_password, SshSession};
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

/// 공통 헬퍼: connect → pool.insert → emit Connected → spawn supervisor.
///
/// `connection_open` (config alias 기반) 과 `connection_open_adhoc`
/// (직접 입력 host/port/user) 가 공유.
///
/// `password` 가 `Some` 이면 키/agent 실패 시 마지막 fallback 으로 사용.
/// 사용 여부와 무관하게 이 함수가 끝나기 전 평문은 `zeroize_string` 으로
/// best-effort 제거된다 — CLAUDE.md §5 ("drop 시 zeroize 노력").
#[allow(clippy::too_many_arguments)] // 연결 입력 + 두 호스트키 신뢰 플래그.
async fn open_and_register(
    host: SshHostEntry,
    all_hosts: &[SshHostEntry],
    mut password: Option<String>,
    trust_host_key: bool,
    replace_changed_host_key: bool,
    pool: &Arc<ConnectionPool>,
    app: &tauri::AppHandle,
) -> Result<ConnectionDto, DuetError> {
    // 키 → agent fallback. AuthFailed 면 password 가 있을 때만 마지막 시도.
    // trust_host_key=true 면 미지의 호스트키를 known_hosts 에 기록(사용자 신뢰 후 재연결).
    // replace_changed_host_key=true 면 변경된 키를 백업 후 교체(사용자 검증 후 명시 승인).
    let connect_result =
        match connect(&host, all_hosts, trust_host_key, replace_changed_host_key).await {
            Ok(s) => Ok(s),
            Err(DuetError::AuthFailed) => match password.as_deref() {
                Some(pw) => {
                    connect_with_password(
                        &host.hostname,
                        host.port,
                        &host.user,
                        pw,
                        trust_host_key,
                        replace_changed_host_key,
                    )
                    .await
                }
                None => Err(DuetError::AuthFailed),
            },
            Err(e) => Err(e),
        };
    // 성공/실패 무관하게 평문 비밀번호 즉시 zeroize (§5).
    if let Some(mut pw) = password.take() {
        crate::services::secret_vault::zeroize_string(&mut pw);
    }
    let session: SshSession = connect_result?;

    let id = ConnectionId(format!("{}:{}", host.alias, uuid::Uuid::new_v4()));
    let host_ip = session.host_ip;
    pool.insert(ActiveConnection {
        id: id.clone(),
        alias: host.alias.clone(),
        host_ip,
        user: host.user.clone(),
        session: Some(tokio::sync::Mutex::new(session.handle)),
        rsync_available: tokio::sync::Mutex::new(None),
        browse_temp_dirs: tokio::sync::Mutex::new(Vec::new()),
    })
    .await;

    // emit 실패는 non-fatal — 연결 자체는 성공했으므로 Ok 로 반환.
    let _ = ConnectionStateEvent {
        id: id.clone(),
        alias: host.alias.clone(),
        host_ip: host_ip.to_string(),
        user: host.user.clone(),
        state: ConnectionStateChange::Connected,
    }
    .emit(app);

    // 백그라운드 supervisor — 연결 끊김 감지 + 자동 재연결.
    spawn_supervisor(pool.clone(), app.clone(), id.clone());

    Ok(ConnectionDto {
        id,
        alias: host.alias,
        host_ip: host_ip.to_string(),
        user: host.user,
    })
}

/// 새 SSH 연결 open + ConnectionPool 등록 — `~/.ssh/config` 의 alias 기반.
///
/// `password` 가 `Some` 이면 키/agent 실패 시 마지막 fallback. ProxyJump
/// 호스트는 password fallback 시 jump 단계 인증은 키/agent 만 — target 단만
/// password 시도 (jump 호스트 password 는 미지원).
#[tauri::command]
#[specta::specta]
pub async fn connection_open(
    alias: String,
    password: Option<String>,
    trust_host_key: bool,
    replace_changed_host_key: bool,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    app: tauri::AppHandle,
) -> Result<ConnectionDto, DuetError> {
    let all_hosts = load_ssh_hosts()?;
    let host = all_hosts
        .iter()
        .find(|h| h.alias == alias)
        .cloned()
        .ok_or_else(|| {
            DuetError::ConnectionFailed(format!("alias not found in ssh config: {alias}"))
        })?;
    open_and_register(
        host,
        &all_hosts,
        password,
        trust_host_key,
        replace_changed_host_key,
        pool.inner(),
        &app,
    )
    .await
}

/// Ad-hoc SSH 연결 — `~/.ssh/config` 에 없는 host 에 직접 입력으로 접속.
///
/// `key_path` 가 None 이면 SSH agent 시도. `password` 가 Some 이면 키/agent
/// 둘 다 실패 시 fallback. 모두 실패면 `AuthFailed`.
/// `proxy_jump` 미지원 — config 기반 alias 가 필요.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // IPC command — 인자는 ad-hoc 연결 입력값 그대로.
pub async fn connection_open_adhoc(
    host: String,
    port: u16,
    user: String,
    key_path: Option<PathBuf>,
    password: Option<String>,
    trust_host_key: bool,
    replace_changed_host_key: bool,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    app: tauri::AppHandle,
) -> Result<ConnectionDto, DuetError> {
    if host.trim().is_empty() {
        return Err(DuetError::Io("host required".into()));
    }
    if user.trim().is_empty() {
        return Err(DuetError::Io("user required".into()));
    }
    let entry = SshHostEntry {
        alias: format!("{user}@{host}:{port}"),
        hostname: host,
        port,
        user,
        identity_files: key_path.into_iter().collect(),
        proxy_jump: vec![],
    };
    open_and_register(
        entry,
        &[],
        password,
        trust_host_key,
        replace_changed_host_key,
        pool.inner(),
        &app,
    )
    .await
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
    // in-flight 재연결이 있으면 즉시 취소 — 종료한 연결이 되살아나는(resurrection) 경합 차단.
    pool.cancel_reconnect(&id).await;
    let snapshot = pool.get(&id).await.ok();
    // 종료 전, 이 연결로 만든 원격 아카이브 browse 임시 디렉토리를 host-side 에서
    // reap (세션이 살아있는 동안). best-effort — 이후 disconnect/remove 는 그대로 진행.
    if let Some(conn) = snapshot.as_ref() {
        let roots = conn.take_browse_dirs().await;
        if !roots.is_empty() {
            crate::core::archive::reap_remote_browse_dirs(pool.inner(), &id, &roots).await;
        }
    }
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

/// 로컬 SSH 공개키 한 개 찾기 — `~/.ssh/id_ed25519.pub` > `id_ecdsa.pub` > `id_rsa.pub`.
/// 공개키만 읽는다 (비밀키/비번 안 건드림 — §5 무관).
fn local_public_key() -> Result<String, DuetError> {
    let ssh_dir = dirs::home_dir()
        .ok_or_else(|| DuetError::Io("home directory not found".into()))?
        .join(".ssh");
    for name in ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"] {
        if let Ok(text) = std::fs::read_to_string(ssh_dir.join(name)) {
            let line = text.trim();
            if !line.is_empty() {
                return Ok(line.to_string());
            }
        }
    }
    Err(DuetError::Io(
        "no local SSH public key found (~/.ssh/id_ed25519.pub 등). \
         `ssh-keygen -t ed25519` 로 생성 후 다시 시도."
            .into(),
    ))
}

/// `ssh-copy-id` 와 동일 — umask 077, `<home>/.ssh` 생성, dedup append, 권한 보정,
/// **마지막에 재확인 grep** 으로 exit status 가 "키가 실제로 들어있는지"를 반영한다
/// (false success 차단). **절대 home 경로**를 받아 `~` 셸 확장에 의존하지 않는다.
/// 인자(home/pubkey)는 single-quote escape.
fn build_install_pubkey_cmd(home: &str, pubkey: &str) -> String {
    let k = pubkey.replace('\'', "'\\''");
    let h = home.replace('\'', "'\\''");
    format!(
        "umask 077; mkdir -p '{h}/.ssh' && touch '{h}/.ssh/authorized_keys' && \
         {{ grep -qxF '{k}' '{h}/.ssh/authorized_keys' || printf '%s\\n' '{k}' >> '{h}/.ssh/authorized_keys'; }} && \
         chmod 700 '{h}/.ssh' && chmod 600 '{h}/.ssh/authorized_keys' && \
         grep -qxF '{k}' '{h}/.ssh/authorized_keys'"
    )
}

/// 로컬 공개키를 원격 `<home>/.ssh/authorized_keys` 에 설치 (ssh-copy-id).
///
/// 비밀번호로 접속한 뒤 이걸 호출하면, 이후 `connect`(키→agent→비번 폴백)가 키로
/// 자동 인증 → 비밀번호 불필요. 키 생성은 하지 않는다 (로컬 키 없으면 안내 에러).
/// home 은 SFTP `canonicalize(".")` 로 받은 절대경로 — `~` 미사용. 원격 변경은
/// russh exec (§9). 공개키만 다룸 (§5 무관). 성공 시 설치된 절대경로 반환(검증용).
#[tauri::command]
#[specta::specta]
pub async fn ssh_setup_key_auth(
    connection_id: ConnectionId,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
) -> Result<String, DuetError> {
    let pubkey = local_public_key()?;
    let conn = pool.inner().get(&connection_id).await?;
    // 절대 home 경로 (SFTP canonicalize) — `~` 셸 확장에 의존 안 함.
    let home = crate::fs::SshFs::new(Arc::clone(&conn)).home().await?;
    let home_str = home
        .to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 remote home".into()))?;
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    let cmd = build_install_pubkey_cmd(home_str, &pubkey);
    let out = {
        let handle = session_mutex.lock().await;
        crate::ssh::remote_exec::exec(&handle, &cmd).await?
    };
    if out.exit_status == 0 {
        Ok(format!("{home_str}/.ssh/authorized_keys"))
    } else {
        Err(DuetError::Ssh(format!(
            "key install failed (exit {}): {}",
            out.exit_status,
            String::from_utf8_lossy(&out.stderr).trim()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::config::SshHostEntry;
    use std::path::PathBuf;

    #[test]
    fn install_pubkey_cmd_is_ssh_copy_id_shaped() {
        let cmd = build_install_pubkey_cmd("/home/u", "ssh-ed25519 AAAAC3Nz user@host");
        // 절대경로 사용 (~ 미사용).
        assert!(cmd.contains("mkdir -p '/home/u/.ssh'"));
        assert!(!cmd.contains("~/.ssh"));
        assert!(cmd
            .contains("grep -qxF 'ssh-ed25519 AAAAC3Nz user@host' '/home/u/.ssh/authorized_keys'"));
        assert!(cmd.contains(">> '/home/u/.ssh/authorized_keys'")); // append
        assert!(cmd.contains("chmod 700 '/home/u/.ssh'"));
        assert!(cmd.contains("chmod 600 '/home/u/.ssh/authorized_keys'"));
        assert!(cmd.contains("umask 077"));
        // 마지막 재확인 grep — exit status 가 키 존재 여부를 반영.
        assert!(cmd.trim_end().ends_with(
            "grep -qxF 'ssh-ed25519 AAAAC3Nz user@host' '/home/u/.ssh/authorized_keys'"
        ));
    }

    #[test]
    fn install_pubkey_cmd_escapes_single_quote() {
        // 키/home 에 ' 가 있어도(이례적) 셸 인젝션 안 되게 escape.
        let cmd = build_install_pubkey_cmd("/home/u", "ab'cd");
        assert!(cmd.contains("ab'\\''cd"));
    }

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
