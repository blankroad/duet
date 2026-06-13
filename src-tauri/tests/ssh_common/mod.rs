//! SSH 통합 테스트 공유 하니스.
//!
//! `tests/` 하위 디렉토리 모듈이라 독립 테스트 바이너리로 컴파일되지 않는다.
//! 각 `ssh_it_*.rs` 가 `mod ssh_common;` 로 포함한다.
//!
//! 모든 함수는 `duet_lib` 의 공개 API 만 사용 — 테스트가 앱의 실제 진입점
//! (`connection::connect_*`, `SshFs`, `copy_execute`, `SshFilenameSearch`)을
//! 그대로 구동하도록 한다. 새 프로덕션 코드는 추가하지 않는다.
//!
//! 게이트: `DUET_SSH_IT=1` 이 아니면 각 테스트는 즉시 skip 한다. 픽스처는
//! `scripts/ssh-it.sh` 가 `docker compose` 로 띄운다 (CLAUDE.md §9 는 앱 코드의
//! 시스템 ssh 호출 금지 — 테스트 하니스의 docker 호출과는 무관).
#![allow(dead_code)] // 테스트 바이너리마다 사용하는 헬퍼가 달라 일부는 미사용일 수 있음.

use std::path::PathBuf;
use std::sync::Arc;

use duet_lib::services::connection_pool::{ActiveConnection, ConnectionPool};
use duet_lib::services::journal::Journal;
use duet_lib::services::settings::SettingsStore;
use duet_lib::ssh::connection::{self, SshSession};
use duet_lib::ssh::remote_exec::{exec, ExecOutput};
use duet_lib::types::{ConnectionId, EntryRef, Location, SourceId};
use tempfile::TempDir;

/// `DUET_SSH_IT=1` 일 때만 통합 테스트 실행. 아니면 호출자가 skip.
pub fn enabled() -> bool {
    std::env::var("DUET_SSH_IT").as_deref() == Ok("1")
}

/// 게이트 OFF 면 메시지 출력 후 `true` 반환 — 호출자가 `return` 하도록.
///
/// ```ignore
/// #[tokio::test]
/// #[ignore]
/// async fn my_it() {
///     if ssh_common::skip_if_disabled() { return; }
///     ...
/// }
/// ```
pub fn skip_if_disabled() -> bool {
    if enabled() {
        return false;
    }
    eprintln!("[ssh-it] skipped — set DUET_SSH_IT=1 (see scripts/ssh-it.sh)");
    true
}

/// 접속 파라미터 — env override, 기본값은 docker-compose 픽스처와 일치.
pub struct Host {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub pass: String,
    /// 개인키 경로. 있으면 키 인증 경로도 검증 가능.
    pub key: Option<PathBuf>,
}

impl Host {
    pub fn from_env() -> Self {
        fn env_or(key: &str, default: &str) -> String {
            std::env::var(key).unwrap_or_else(|_| default.to_string())
        }
        Host {
            host: env_or("DUET_SSH_IT_HOST", "127.0.0.1"),
            port: env_or("DUET_SSH_IT_PORT", "2222").parse().unwrap_or(2222),
            user: env_or("DUET_SSH_IT_USER", "duet"),
            pass: env_or("DUET_SSH_IT_PASS", "duetpass"),
            key: std::env::var("DUET_SSH_IT_KEY").ok().map(PathBuf::from),
        }
    }
}

/// 연결된 세션 + pool 묶음. `ActiveConnection` 은 pool 안에도 들어있고
/// 직접 참조도 제공 (rsync_available 토글 등).
pub struct Session {
    pub pool: Arc<ConnectionPool>,
    pub conn: Arc<ActiveConnection>,
    pub conn_id: ConnectionId,
    pub source: SourceId,
}

/// 비밀번호로 접속 → `ConnectionPool` 에 등록 → `Session` 반환.
///
/// `ActiveConnection` 생성은 프로덕션 경로
/// (`commands/connection.rs::open_and_register`)와 동일한 필드 구성을 미러한다.
pub async fn connect_password(host: &Host) -> Session {
    let session = connection::connect_with_password(&host.host, host.port, &host.user, &host.pass)
        .await
        .expect("connect_with_password failed — 컨테이너가 떠 있는지 확인 (scripts/ssh-it.sh)");
    register(host, session).await
}

/// 키파일로 접속 (`host.key` 필요) → `Session`.
pub async fn connect_key(host: &Host) -> Session {
    let key = host
        .key
        .as_ref()
        .expect("DUET_SSH_IT_KEY 미설정 — connect_key 호출 전 확인");
    let session = connection::connect_with_key(&host.host, host.port, &host.user, key, None)
        .await
        .expect("connect_with_key failed");
    register(host, session).await
}

async fn register(host: &Host, session: SshSession) -> Session {
    let conn_id = ConnectionId(format!("ssh-it-{}-{}", host.user, host.port));
    let active = ActiveConnection {
        id: conn_id.clone(),
        alias: "ssh-it".to_string(),
        host_ip: session.host_ip,
        user: host.user.clone(),
        session: Some(tokio::sync::Mutex::new(session.handle)),
        rsync_available: tokio::sync::Mutex::new(None),
    };
    let pool = ConnectionPool::new();
    pool.insert(active).await;
    let conn = pool.get(&conn_id).await.unwrap();
    let source = conn.source_id();
    Session {
        pool,
        conn,
        conn_id,
        source,
    }
}

/// 원격 셸 명령 실행 (픽스처 seed / 검증용). exit !=0 면 panic.
pub async fn run(conn: &Arc<ActiveConnection>, cmd: &str) -> ExecOutput {
    let handle = conn
        .session
        .as_ref()
        .expect("no session")
        .lock()
        .await;
    let out = exec(&handle, cmd).await.expect("remote exec failed");
    assert_eq!(
        out.exit_status,
        0,
        "remote cmd failed (exit {}): {}\nstderr: {}",
        out.exit_status,
        cmd,
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

/// exit code 무관하게 결과 반환 (실패를 의도적으로 검사할 때).
pub async fn run_raw(conn: &Arc<ActiveConnection>, cmd: &str) -> ExecOutput {
    let handle = conn.session.as_ref().expect("no session").lock().await;
    exec(&handle, cmd).await.expect("remote exec failed")
}

/// 원격 stdout 을 trim 한 문자열로.
pub async fn stdout_str(conn: &Arc<ActiveConnection>, cmd: &str) -> String {
    let out = run(conn, cmd).await;
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// 원격 홈 디렉토리 절대경로 (`$HOME`). SFTP/copy 경로는 `~` 확장이 안 되므로
/// 절대경로가 필요하다.
pub async fn home(conn: &Arc<ActiveConnection>) -> String {
    stdout_str(conn, "echo -n \"$HOME\"").await
}

/// 단일 파일 sha256 (hex).
pub async fn sha256_file(conn: &Arc<ActiveConnection>, path: &str) -> String {
    let out = stdout_str(conn, &format!("sha256sum -- '{path}'")).await;
    out.split_whitespace().next().unwrap_or("").to_string()
}

/// 디렉토리 트리의 내용 합산 해시 — 파일 경로(상대) + 내용 정렬 후 sha256.
/// 두 디렉토리의 동일성 비교용.
pub async fn sha256_tree(conn: &Arc<ActiveConnection>, dir: &str) -> String {
    // 각 파일의 "상대경로  해시" 를 정렬해 합친 뒤 다시 해시.
    let cmd = format!(
        "cd -- '{dir}' && find . -type f | sort | xargs -r sha256sum | sha256sum",
    );
    let out = stdout_str(conn, &cmd).await;
    out.split_whitespace().next().unwrap_or("").to_string()
}

// === 도메인 타입 헬퍼 ===

/// pool 안 connection 의 `SourceId::Ssh`.
pub fn source_of(sess: &Session) -> SourceId {
    sess.source.clone()
}

pub fn loc(source: SourceId, path: impl Into<PathBuf>) -> Location {
    Location {
        source,
        path: path.into(),
    }
}

pub fn entry(source: SourceId, dir: impl Into<PathBuf>, name: &str) -> EntryRef {
    EntryRef {
        location: loc(source, dir),
        name: name.to_string(),
    }
}

/// `OpCtx` 구성 — 임시 cfg 디렉토리에 실제 SettingsStore/Journal.
/// `pool` 은 same-host copy 가 SSH session 접근에 사용. `app` 은 None (progress
/// emit 는 IT 에서 ProgressEmitter None 으로 생략).
///
/// 반환된 `TempDir` 는 cfg 파일 수명을 위해 호출자가 들고 있어야 한다.
pub async fn mk_ctx(pool: Arc<ConnectionPool>) -> (duet_lib::core::ops::OpCtx, TempDir) {
    let cfg = TempDir::new().unwrap();
    let settings = SettingsStore::load_from(&cfg.path().join("s.toml"))
        .await
        .unwrap();
    let journal = Journal::load_from(&cfg.path().join("j.jsonl"))
        .await
        .unwrap();
    (
        duet_lib::core::ops::OpCtx {
            settings,
            journal,
            pool: Some(pool),
            app: None,
        },
        cfg,
    )
}
