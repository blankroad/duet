# MVP-1 Implementation Plan: SSH 연결

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SSH 호스트에 연결해서 한 쪽 패널을 SFTP로 띄울 수 있다. 로컬 + 원격 한 곳씩 read-only 듀얼 패널.

**Architecture:** russh + russh-sftp 단일 스택 (CLAUDE.md §9 — 시스템 `ssh`/`sftp`/`scp` 명령 호출 금지). `ConnectionPool` 서비스가 활성 SSH 세션을 관리. `SshFs` 가 `FileSystem` trait 구현. 연결 직후 `getpeername()` 으로 peer IP 캡처해 `SourceId::Ssh.host_ip` 채움. ProxyJump는 russh의 nested session (pure Rust). 인증은 키파일 → SSH agent → 비밀번호 순서 fallback.

**Tech Stack:** russh 0.46, russh-sftp 2.0, russh-keys 0.46 (이미 Cargo.toml 에 있음), ssh2-config 0.4, notify 7 (로컬 fs:changed), 백엔드 tracing (디버그), 프론트 Zustand (connections store).

**Spec references:**
- `ARCHITECTURE.md` §"백엔드 레이어 책임" — ssh 모듈 책임, fs 레이어, services
- `DESIGN.md` §"사이드바", §"다이얼로그 패턴" — 호스트 목록, 새 연결 다이얼로그
- `ROADMAP.md` MVP-1 12개 항목
- `CLAUDE.md` 절대 규칙 — 특히 §5 (자격증명 메모리/로그 노출 금지), §9 (시스템 SSH 호출 금지)

**현재 상태 (MVP-0 완료):**
- ✅ FileSystem trait + LocalFs (4 tests)
- ✅ list_directory + home_directory commands (specta)
- ✅ 듀얼 패널 + 키보드 네비 + Sidebar (placeholder) + StatusBar
- ✅ `SourceId::Ssh { connection_id, host_ip, user }` 타입은 이미 정의됨 (사용 안 됨)
- ⚠ `commands/pane.rs` 의 `list_directory` 가 `SourceId::Ssh` 면 에러 반환 — MVP-1 에서 라우팅 추가
- ⚠ Sidebar `Hosts` 섹션은 "(MVP-1)" placeholder

**완료 조건 (ROADMAP MVP-1 일치):**
- `~/.ssh/config` 의 호스트가 사이드바에 자동 표시됨
- 호스트 더블클릭 → 새 연결 다이얼로그 → 인증 (키 또는 비밀번호) → 활성 패널이 SFTP로 전환
- 한 패널은 로컬, 다른 패널은 원격 동시 가능
- 연결 끊김 → 자동 재연결 (지수 백오프)
- 활성 SSH 패널이 다른 프로세스의 디렉토리 변경을 3-5초 내 반영 (stat 폴링)
- 로컬 패널은 `notify` 로 즉시 변경 반영
- 백엔드 fs/core/services 레이어 단위 테스트 통과
- 자격증명 절대 프론트엔드 / 로그 노출 안 됨

---

## 작업 흐름 가이드

각 Task = 독립 커밋. **TDD**: 백엔드 fs/core/services/ssh 레이어는 테스트 먼저. 프론트는 store/hook 만 테스트.

**커밋 메시지 scope (CLAUDE.md):**
- `be/ssh` SSH 레이어 (russh 통합, 인증, ProxyJump)
- `be/svc` services (ConnectionPool, fs:changed)
- `be/fs` SshFs
- `be/cmd` connection_*, ssh_config_hosts
- `fe/store` connections store
- `fe/ui` Sidebar 호스트 목록, ConnectionDialog
- `fe/hook` 이벤트 구독

**보안 원칙 (CLAUDE.md §5 절대 준수):**
- 비밀번호/passphrase 는 **백엔드 메모리에서만** — 프론트 IPC로 전달 금지
- 비밀번호 입력 시 **백엔드가 OS native dialog** (tauri-plugin-dialog) 사용 OR secure prompt
- `tracing` 출력에서 자격증명 마스킹 (Debug derive 시 `#[derivative(Debug)]` 또는 수동 impl)
- 키파일 경로는 OK (자격증명 아님), 패스프레이즈는 NOT OK

**MVP 분할 권장 (선택):**
이 plan 은 12 항목 모두 한 plan 에 담음. 실행 시점에 Phase 단위로 끊어서 진행해도 OK:
- Phase A-D (백엔드 SSH + 명령): Phase 1
- Phase E-G (프론트엔드 + 이벤트): Phase 2

---

## Phase A: SSH Config + Connection Pool 스켈레톤

### Task 1: ssh/config.rs — `~/.ssh/config` 파싱

**Files:**
- Create: `src-tauri/src/ssh/config.rs`
- Modify: `src-tauri/src/ssh/mod.rs`

**Why:** Sidebar 가 호스트 목록 표시하려면 `~/.ssh/config` 의 Host 엔트리를 읽을 수 있어야 함. `ssh2-config = "0.4"` 가 이미 Cargo.toml 에 있음.

- [ ] **Step 1: 모듈 선언**

`src-tauri/src/ssh/mod.rs` 갱신:

```rust
//! SSH 연결 관리. russh 단일 스택 (시스템 ssh 호출 금지 — CLAUDE.md §9).

pub mod config;

// connection.rs, fs.rs 는 후속 Task
```

- [ ] **Step 2: 테스트 먼저 — failing**

`src-tauri/src/ssh/config.rs`:

```rust
//! `~/.ssh/config` 파싱 — Host 엔트리 + 호스트별 옵션 (Hostname, Port, User, IdentityFile, ProxyJump).

use crate::types::DuetError;
use std::path::PathBuf;

/// `~/.ssh/config` 의 Host 엔트리 한 개의 해석된 형태.
#[derive(Debug, Clone)]
pub struct SshHostEntry {
    /// `Host` 라인의 패턴 (e.g. "myserver", "*.example.com")
    pub alias: String,
    /// 실제 연결할 호스트 (Hostname 옵션, 없으면 alias)
    pub hostname: String,
    /// 포트 (기본 22)
    pub port: u16,
    /// 사용자 (User 옵션, 없으면 현재 OS 사용자)
    pub user: String,
    /// IdentityFile 경로 목록
    pub identity_files: Vec<PathBuf>,
    /// ProxyJump alias 목록 (e.g. ["bastion"]; 빈 배열이면 직접 연결)
    pub proxy_jump: Vec<String>,
}

/// `~/.ssh/config` 를 읽어서 Host 엔트리 목록 반환.
/// 와일드카드 패턴 (`Host *`) 은 적용 가능한 곳에 머지.
pub fn load_ssh_hosts() -> Result<Vec<SshHostEntry>, DuetError> {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_host_entry() {
        // ssh_config 파일을 임시로 만들어서 테스트
        // 실제로는 load_ssh_hosts() 가 ~/.ssh/config 를 직접 읽지만,
        // 테스트에서는 fixture 경로를 받는 helper 를 노출하는 게 깔끔.
        // (구현 시 load_ssh_hosts_from(path: &Path) -> ... 분리)
        unimplemented!("fixture-based test")
    }
}
```

**Note**: 테스트하려면 `load_ssh_hosts_from(path: &Path)` 같은 분리가 필요. 구현 시 그렇게 작성.

- [ ] **Step 3: 분리 + 구현**

```rust
pub fn load_ssh_hosts() -> Result<Vec<SshHostEntry>, DuetError> {
    let path = dirs::home_dir()
        .ok_or_else(|| DuetError::Io("home directory not found".into()))?
        .join(".ssh/config");
    if !path.exists() {
        return Ok(Vec::new()); // ~/.ssh/config 없는 게 에러 아님
    }
    load_ssh_hosts_from(&path)
}

pub fn load_ssh_hosts_from(path: &std::path::Path) -> Result<Vec<SshHostEntry>, DuetError> {
    let config = ssh2_config::SshConfig::default()
        .parse(&mut std::io::BufReader::new(
            std::fs::File::open(path).map_err(DuetError::from)?,
        ), ssh2_config::ParseRule::ALLOW_UNKNOWN_FIELDS)
        .map_err(|e| DuetError::Io(format!("ssh config parse: {e}")))?;

    let current_user = std::env::var("USER").unwrap_or_else(|_| "root".to_string());

    let mut entries = Vec::new();
    for host in config.get_hosts() {
        // Host 패턴이 와일드카드만 (`*`) 인 건 skip — 실제 호스트 아님
        if host.pattern.iter().all(|p| p.pattern.contains('*')) {
            continue;
        }
        let alias = host.pattern.first().map(|p| p.pattern.clone()).unwrap_or_default();
        let params = config.query(&alias);

        entries.push(SshHostEntry {
            hostname: params.host_name.clone().unwrap_or_else(|| alias.clone()),
            port: params.port.unwrap_or(22),
            user: params.user.clone().unwrap_or_else(|| current_user.clone()),
            identity_files: params.identity_file.clone().unwrap_or_default(),
            proxy_jump: params.proxy_jump.clone().unwrap_or_default(),
            alias,
        });
    }
    Ok(entries)
}
```

(ssh2-config crate API는 버전에 따라 약간 다를 수 있음. 컴파일 에러 시 `cargo doc --open -p ssh2-config` 로 확인.)

- [ ] **Step 4: 테스트**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn empty_config_returns_empty() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(b"").unwrap();
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        assert!(hosts.is_empty());
    }

    #[test]
    fn parses_hostname_port_user() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(b"Host myserver\n  Hostname 192.168.1.10\n  Port 2222\n  User admin\n").unwrap();
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "myserver");
        assert_eq!(hosts[0].hostname, "192.168.1.10");
        assert_eq!(hosts[0].port, 2222);
        assert_eq!(hosts[0].user, "admin");
    }

    #[test]
    fn skips_wildcard_only_patterns() {
        let mut f = NamedTempFile::new().unwrap();
        f.write_all(b"Host *\n  User defaultuser\n\nHost real-host\n  Hostname real.example.com\n").unwrap();
        let hosts = load_ssh_hosts_from(f.path()).unwrap();
        // `Host *` 는 wildcard만 — skip. real-host 만 남음.
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].alias, "real-host");
    }
}
```

```bash
cd src-tauri && cargo test --lib ssh::config::tests
```

기대: 3 passed.

- [ ] **Step 5: 커밋**

```bash
git add src-tauri/src/ssh/
git commit -m "be/ssh: ~/.ssh/config 파싱 (ssh2-config)

SshHostEntry 구조체. load_ssh_hosts / load_ssh_hosts_from.
와일드카드(*) 패턴 entry 는 sidebar 표시 대상 아니므로 skip.
3 tests."
```

---

### Task 2: ConnectionPool 스켈레톤 (services/connection_pool.rs)

**Files:**
- Create: `src-tauri/src/services/connection_pool.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Why:** SSH 세션 lifecycle 관리 (open/close/get/list). 후속 Task 들이 이걸 통해서 SSH 작업.

- [ ] **Step 1: services/mod.rs**

```rust
//! 앱 서비스 — 비동기 작업 큐, 저널, 연결 풀, 설정.

pub mod connection_pool;
```

- [ ] **Step 2: connection_pool.rs 스켈레톤 (구현 비어있음)**

```rust
//! SSH 활성 연결 풀.
//!
//! 한 ConnectionId 당 한 SSH session. `open` 으로 열고 `get` 으로 참조 획득.
//! 연결 끊김은 후속 Task 에서 watcher 추가.

use crate::types::{ConnectionId, DuetError, SourceId};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 활성 SSH 연결 한 개의 메타데이터.
/// 실제 russh handle 은 후속 Task 에서 추가 (지금은 placeholder).
#[derive(Debug, Clone)]
pub struct ActiveConnection {
    pub id: ConnectionId,
    pub alias: String,        // ~/.ssh/config Host 별칭
    pub host_ip: IpAddr,      // getpeername() 결과
    pub user: String,
}

impl ActiveConnection {
    pub fn source_id(&self) -> SourceId {
        SourceId::Ssh {
            connection_id: self.id.clone(),
            host_ip: self.host_ip,
            user: self.user.clone(),
        }
    }
}

/// 활성 연결들을 관리. Tauri State 로 등록 — `tauri::State<Arc<ConnectionPool>>`.
#[derive(Default)]
pub struct ConnectionPool {
    inner: RwLock<HashMap<ConnectionId, Arc<ActiveConnection>>>,
}

impl ConnectionPool {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 연결 추가. 이미 같은 id 면 덮어쓰기 (재연결 케이스).
    pub async fn insert(&self, conn: ActiveConnection) {
        let id = conn.id.clone();
        self.inner.write().await.insert(id, Arc::new(conn));
    }

    pub async fn get(&self, id: &ConnectionId) -> Result<Arc<ActiveConnection>, DuetError> {
        self.inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| DuetError::ConnectionFailed(format!("no connection: {}", id.0)))
    }

    pub async fn remove(&self, id: &ConnectionId) {
        self.inner.write().await.remove(id);
    }

    pub async fn list(&self) -> Vec<Arc<ActiveConnection>> {
        self.inner.read().await.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_conn(id: &str, ip: &str) -> ActiveConnection {
        ActiveConnection {
            id: ConnectionId(id.to_string()),
            alias: id.to_string(),
            host_ip: ip.parse().unwrap(),
            user: "test".to_string(),
        }
    }

    #[tokio::test]
    async fn insert_get_remove() {
        let pool = ConnectionPool::new();
        pool.insert(mk_conn("a", "10.0.0.1")).await;
        let got = pool.get(&ConnectionId("a".into())).await.unwrap();
        assert_eq!(got.alias, "a");
        pool.remove(&ConnectionId("a".into())).await;
        assert!(pool.get(&ConnectionId("a".into())).await.is_err());
    }

    #[tokio::test]
    async fn list_returns_all() {
        let pool = ConnectionPool::new();
        pool.insert(mk_conn("a", "10.0.0.1")).await;
        pool.insert(mk_conn("b", "10.0.0.2")).await;
        let all = pool.list().await;
        assert_eq!(all.len(), 2);
    }
}
```

- [ ] **Step 3: 테스트**

```bash
cd src-tauri && cargo test --lib services::connection_pool::tests
```

기대: 2 passed.

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/services/
git commit -m "be/svc: ConnectionPool 스켈레톤

ActiveConnection (id, alias, host_ip, user) + Arc<RwLock<HashMap>>.
real russh handle 은 Task 4 에서 추가. 2 tests."
```

---

## Phase B: russh 연결 + 인증

### Task 3: ssh/connection.rs — russh client + key auth

**Files:**
- Create: `src-tauri/src/ssh/connection.rs`
- Modify: `src-tauri/src/ssh/mod.rs` (`pub mod connection;`)
- Modify: `src-tauri/src/services/connection_pool.rs` (ActiveConnection 에 `russh::client::Handle` 추가)

**Why:** 실제 SSH 핸드셰이크 + 키 인증. 비밀번호/agent 는 후속 Task.

이 Task 는 큼. 단계적으로:

- [ ] **Step 1: russh client handler 구현**

`src-tauri/src/ssh/connection.rs`:

```rust
//! russh 기반 SSH 클라이언트 연결.
//!
//! - `connect_with_key`: 키파일 인증으로 새 세션
//! - `connect_with_agent`: SSH agent (SSH_AUTH_SOCK)
//! - `connect_with_password`: 비밀번호 (메모리에서만, 로그 절대 X)
//! - ProxyJump 는 nested session 으로 (Task 7)

use crate::types::DuetError;
use russh::client::{Config, Handle, Handler, Msg};
use russh::keys::{key, load_secret_key};
use russh::ChannelMsg;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;

/// 호스트키를 무조건 수락하는 client handler.
/// MVP-1 은 known_hosts 검증 생략 — MVP-2 이상에서 strict 로 강화.
struct AcceptAllHandler;

#[async_trait::async_trait]
impl Handler for AcceptAllHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _key: &key::PublicKey) -> Result<bool, Self::Error> {
        // TODO (MVP-2+): known_hosts 검증
        Ok(true)
    }
}

/// 연결 결과. session handle + 핸드셰이크 시점에 잡은 peer IP.
pub struct SshSession {
    pub handle: Handle<AcceptAllHandler>,
    pub host_ip: IpAddr,
}

/// 키파일로 SSH 연결 (passphrase 없는 키만 — passphrase 필요 시 secure prompt 후 인증).
pub async fn connect_with_key(
    hostname: &str,
    port: u16,
    user: &str,
    key_path: &Path,
    passphrase: Option<&str>,
) -> Result<SshSession, DuetError> {
    let config = Arc::new(Config {
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    });

    let tcp = TcpStream::connect((hostname, port))
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("{hostname}:{port} — {e}")))?;
    let host_ip = tcp
        .peer_addr()
        .map_err(|e| DuetError::ConnectionFailed(format!("getpeername: {e}")))?
        .ip();

    let mut handle = russh::client::connect_stream(config, AcceptAllHandler, tcp)
        .await
        .map_err(|e| DuetError::ConnectionFailed(format!("ssh handshake: {e}")))?;

    let secret = load_secret_key(key_path, passphrase)
        .map_err(|e| DuetError::AuthFailed)?;
    let auth_ok = handle
        .authenticate_publickey(user, Arc::new(secret))
        .await
        .map_err(|e| DuetError::Ssh(format!("publickey auth: {e}")))?;

    if !auth_ok {
        return Err(DuetError::AuthFailed);
    }

    Ok(SshSession { handle, host_ip })
}
```

NOTE: `russh` 0.46 API 디테일은 버전마다 약간 다름. `russh::client::connect_stream` 시그니처가 다르면 `russh::client::connect` 직접 호출 + 본인 TcpStream wrap.

- [ ] **Step 2: 테스트 (mock SSH 서버 — 외부 의존 없이)**

```rust
#[cfg(test)]
mod tests {
    // 실제 SSH 핸드셰이크는 외부 서버 없이 테스트하기 어려움.
    // MVP-1 에서는:
    //  - peer_addr 로직 분리해서 단위 테스트
    //  - 통합 테스트는 docker openssh-server 또는 사용자 환경의 localhost sshd 가 있을 때만
    //
    // 일단 컴파일 + 시그니처 sanity check 만:

    #[test]
    fn signature_compiles() {
        // 인자 타입이 맞는지만 확인
        let _ = super::connect_with_key;
    }
}
```

(통합 테스트는 후속에서 — `tests/ssh_integration.rs`)

- [ ] **Step 3: ConnectionPool에 russh handle 통합**

`src-tauri/src/services/connection_pool.rs` 의 `ActiveConnection` 갱신:

```rust
pub struct ActiveConnection {
    pub id: ConnectionId,
    pub alias: String,
    pub host_ip: IpAddr,
    pub user: String,
    /// SSH session — Mutex 로 감싸서 동시 접근 직렬화 (russh handle 자체는 thread-safe 아님)
    pub session: tokio::sync::Mutex<russh::client::Handle<crate::ssh::connection::AcceptAllHandler>>,
}
```

(`Debug` derive 는 session 때문에 안 됨 — `Debug` 수동 impl 또는 derive 제거. 자격증명 노출 위험 있어서 manual impl 권장 — 세션 내용 절대 출력 X.)

- [ ] **Step 4: 컴파일 확인 + 커밋**

```bash
cd src-tauri && cargo check
git add src-tauri/src/ssh/ src-tauri/src/services/connection_pool.rs
git commit -m "be/ssh: russh client + 키파일 인증

connect_with_key — TcpStream + russh handshake + publickey auth.
peer_addr 로 host_ip 캡처 (브레인스토밍 결정).
호스트키 검증은 MVP-2+ — 지금은 AcceptAll.

ActiveConnection 에 session: Mutex<Handle> 추가."
```

---

### Task 4: SSH agent + password 인증

**Files:**
- Modify: `src-tauri/src/ssh/connection.rs`

- [ ] **Step 1: connect_with_agent 추가**

```rust
/// SSH agent (SSH_AUTH_SOCK) 통한 인증.
pub async fn connect_with_agent(
    hostname: &str,
    port: u16,
    user: &str,
) -> Result<SshSession, DuetError> {
    let config = Arc::new(Config { /* ... 동일 ... */ });
    let tcp = TcpStream::connect((hostname, port)).await
        .map_err(|e| DuetError::ConnectionFailed(format!("{hostname}:{port} — {e}")))?;
    let host_ip = tcp.peer_addr().map_err(|e| DuetError::ConnectionFailed(format!("getpeername: {e}")))?.ip();

    let mut handle = russh::client::connect_stream(config, AcceptAllHandler, tcp).await
        .map_err(|e| DuetError::ConnectionFailed(format!("ssh handshake: {e}")))?;

    // SSH_AUTH_SOCK 에 연결
    let mut agent = russh_keys::agent::client::AgentClient::connect_env().await
        .map_err(|_| DuetError::AuthFailed)?;
    let identities = agent.request_identities().await
        .map_err(|e| DuetError::Ssh(format!("agent: {e}")))?;

    // agent 가 가진 키들로 차례로 시도
    for ident in identities {
        let result = handle.authenticate_future_publickey(user, ident.clone(), &mut agent).await;
        if let Ok(true) = result {
            return Ok(SshSession { handle, host_ip });
        }
    }
    Err(DuetError::AuthFailed)
}
```

(API 정확한 형태는 russh-keys 0.46 docs 확인.)

- [ ] **Step 2: connect_with_password 추가**

```rust
/// 비밀번호 인증.
/// **CLAUDE.md §5: 비밀번호는 함수 인자로만 받음. 호출자가 secure prompt에서 받아 zero-on-drop 변수로 전달.**
/// 함수 본체에서 password 를 string-format 또는 Debug 로 출력 절대 금지.
pub async fn connect_with_password(
    hostname: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<SshSession, DuetError> {
    // ... TcpStream + host_ip + handle 동일 ...

    let auth_ok = handle.authenticate_password(user, password).await
        .map_err(|e| DuetError::Ssh(format!("password auth: {e}")))?;  // ← e 에 비밀번호 포함 안 됨 보장

    if !auth_ok { return Err(DuetError::AuthFailed); }
    Ok(SshSession { handle, host_ip })
}
```

- [ ] **Step 3: 통합 함수 — 인증 fallback 순서**

```rust
/// 호스트 설정 (~/.ssh/config) 기반으로 인증을 차례로 시도.
/// 순서: identity_files → SSH agent → 호출자가 비밀번호 prompt 후 connect_with_password 별도 호출.
pub async fn connect(
    host: &crate::ssh::config::SshHostEntry,
) -> Result<SshSession, DuetError> {
    // 1. identity_files
    for key_path in &host.identity_files {
        match connect_with_key(&host.hostname, host.port, &host.user, key_path, None).await {
            Ok(s) => return Ok(s),
            Err(DuetError::AuthFailed) => continue, // 다음 키 시도
            Err(e) => return Err(e), // 네트워크 에러는 즉시 반환
        }
    }
    // 2. SSH agent
    if let Ok(s) = connect_with_agent(&host.hostname, host.port, &host.user).await {
        return Ok(s);
    }
    // 3. 비밀번호는 호출자가 prompt 후 connect_with_password 호출
    Err(DuetError::AuthFailed)
}
```

- [ ] **Step 4: 컴파일 + 커밋**

```bash
cd src-tauri && cargo check && cargo clippy -- -D warnings
git add src-tauri/src/ssh/connection.rs
git commit -m "be/ssh: SSH agent + 비밀번호 인증 + connect() fallback

- connect_with_agent: SSH_AUTH_SOCK
- connect_with_password: 메모리에서만 — Debug/log 출력 X (CLAUDE.md §5)
- connect(): 키파일 → agent → AuthFailed (호출자가 비밀번호 prompt)"
```

---

### Task 5: ProxyJump 지원 (russh nested session)

**Files:**
- Modify: `src-tauri/src/ssh/connection.rs`

**Why:** 회사 환경에서 jump host 통과는 흔한 케이스. 시스템 ssh 명령 안 쓰고 (CLAUDE.md §9) russh nested session 으로 구현.

- [ ] **Step 1: jump host 통한 TCP forwarding 헬퍼**

```rust
/// `host` 의 ProxyJump 가 비어있지 않으면 jump 통해 TCP 스트림을 만듦.
/// 비어있으면 직접 TcpStream::connect.
async fn open_stream_via_jumps(
    host: &crate::ssh::config::SshHostEntry,
    config_repo: impl Fn(&str) -> Option<crate::ssh::config::SshHostEntry>,
) -> Result<TcpStream, DuetError> {
    if host.proxy_jump.is_empty() {
        return TcpStream::connect((host.hostname.as_str(), host.port))
            .await
            .map_err(|e| DuetError::ConnectionFailed(format!("{}:{} — {e}", host.hostname, host.port)));
    }

    // jump 목록을 차례로 거쳐서 마지막 hop 만 forward
    let mut current_handle: Option<Handle<AcceptAllHandler>> = None;
    for (idx, jump_alias) in host.proxy_jump.iter().enumerate() {
        let jump_host = config_repo(jump_alias)
            .ok_or_else(|| DuetError::ConnectionFailed(format!("ProxyJump '{}' not in ssh config", jump_alias)))?;

        if let Some(prev) = current_handle.take() {
            // 이전 hop 의 handle 위에 nested SSH 세션
            // 1) prev 가 jump_host 로 향하는 채널 열기
            // 2) 그 채널 위에 새 SSH 핸드셰이크
            unimplemented!("nested SSH via direct-tcpip channel — russh API 적용");
        } else {
            // 첫 hop — 일반 TcpStream
            // jump_host 로 SSH 연결 + 인증
            unimplemented!("first hop SSH connect");
        }
        // TODO: idx == host.proxy_jump.len() - 1 이면 마지막 hop
    }

    unimplemented!("placeholder — Step 2 에서 실제 구현");
}
```

NOTE: russh nested session 의 정확한 패턴은 `russh::client::Handle::channel_open_direct_tcpip` + 그 위에 새 SSH 핸드셰이크. 이 부분은 russh examples 디렉토리 (`examples/proxy.rs`) 참고. 현재 0.46 의 정확한 API 가 docs 에서 확인되지 않으면 해당 example 보고 적용.

- [ ] **Step 2: 점진적 구현 — 단일 jump 부터**

ProxyJump 가 1개인 케이스 먼저:

```rust
// pseudo code:
// 1. TcpStream → jump.hostname:jump.port
// 2. SSH handshake on jump (인증 fallback 적용)
// 3. jump_handle.channel_open_direct_tcpip(host.hostname, host.port, "127.0.0.1", 0)
// 4. 그 채널 위에 새 SSH 핸드셰이크 → 최종 host
// 5. 인증 fallback 적용
```

- [ ] **Step 3: 다중 jump 일반화 — 재귀 또는 fold**

(Optional — 1 hop 만으로 일상 케이스 90% 커버. 2+ hop 은 후속.)

- [ ] **Step 4: 통합 테스트는 docker compose 가 필요해서 별도 — 지금은 컴파일만**

```bash
cd src-tauri && cargo check && cargo clippy -- -D warnings
git add src-tauri/src/ssh/connection.rs
git commit -m "be/ssh: ProxyJump (russh nested session, 1 hop)

CLAUDE.md §9: 시스템 ssh 명령 사용 X. russh 의 channel_open_direct_tcpip
위에 nested SSH 핸드셰이크. 다중 hop 은 후속 — 1 hop 으로 일상 케이스
대부분 커버."
```

---

## Phase C: SshFs (FileSystem trait 구현)

### Task 6: SshFs::list (russh-sftp)

**Files:**
- Create: `src-tauri/src/fs/ssh.rs`
- Modify: `src-tauri/src/fs/mod.rs` (`pub mod ssh;`)
- Modify: `src-tauri/src/services/connection_pool.rs` (sftp client 캐시 추가)

- [ ] **Step 1: SshFs 구조 + list 시그니처**

```rust
//! SSH/SFTP 파일시스템 구현.

use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, SourceId};
use async_trait::async_trait;
use std::path::Path;
use std::sync::Arc;

pub struct SshFs {
    conn: Arc<crate::services::connection_pool::ActiveConnection>,
}

impl SshFs {
    pub fn new(conn: Arc<crate::services::connection_pool::ActiveConnection>) -> Self {
        Self { conn }
    }
}

#[async_trait]
impl FileSystem for SshFs {
    fn source_id(&self) -> SourceId {
        self.conn.source_id()
    }

    async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
        // 1. session 으로부터 sftp subsystem 채널 open (재사용 캐시 가능)
        // 2. opendir → readdir loop
        // 3. 각 entry 를 Entry 로 변환

        let session = self.conn.session.lock().await;
        // ... russh-sftp 호출 ...
        unimplemented!()
    }
}
```

- [ ] **Step 2: russh-sftp 구체 구현**

```rust
async fn list(&self, path: &Path) -> Result<Vec<Entry>, DuetError> {
    use russh_sftp::client::SftpSession;

    let mut session = self.conn.session.lock().await;
    let channel = session.channel_open_session().await
        .map_err(|e| DuetError::Ssh(format!("open session: {e}")))?;
    channel.request_subsystem(true, "sftp").await
        .map_err(|e| DuetError::Ssh(format!("sftp subsystem: {e}")))?;

    let sftp = SftpSession::new(channel.into_stream()).await
        .map_err(|e| DuetError::Ssh(format!("sftp init: {e}")))?;

    let path_str = path.to_str()
        .ok_or_else(|| DuetError::Io("non-UTF8 path".into()))?;

    let entries = sftp.read_dir(path_str).await
        .map_err(|e| match e {
            russh_sftp::client::error::Error::Status(s) if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile
                => DuetError::NotFound(path_str.to_string()),
            russh_sftp::client::error::Error::Status(s) if s.status_code == russh_sftp::protocol::StatusCode::PermissionDenied
                => DuetError::PermissionDenied(path_str.to_string()),
            _ => DuetError::Ssh(format!("read_dir: {e}")),
        })?;

    let mut out = Vec::new();
    for ent in entries {
        let name = ent.file_name();
        let metadata = ent.metadata();
        let kind = if metadata.is_dir() { EntryKind::Dir }
            else if metadata.is_regular() { EntryKind::File }
            else if metadata.file_type() == russh_sftp::protocol::FileType::Symlink { EntryKind::Symlink }
            else { EntryKind::Other };

        out.push(Entry {
            name: name.clone(),
            kind,
            size: metadata.size,
            modified_ms: metadata.mtime.map(|t| (t as i64) * 1000),
            permissions: metadata.permissions.map(|p| p & 0o777),
            hidden: name.starts_with('.'),
        });
    }
    Ok(out)
}
```

NOTE: `russh-sftp` 2.0 API 디테일은 docs.rs 확인.

- [ ] **Step 3: 통합 테스트 — 일단 시그니처만 (실제 SSH 서버 필요)**

```rust
#[cfg(test)]
mod tests {
    #[test]
    fn signature_compiles() {
        let _ = super::SshFs::new;
    }
}
```

- [ ] **Step 4: 커밋**

```bash
git add src-tauri/src/fs/
git commit -m "be/fs: SshFs::list (russh-sftp)

ConnectionPool 의 ActiveConnection 을 받아 SFTP 채널 open + read_dir.
NoSuchFile/PermissionDenied 매핑. mtime 초→ms 변환.
실제 통합 테스트는 docker compose 셋업 후 별도."
```

---

## Phase D: IPC Commands

### Task 7: connection_open / close / list / ssh_config_hosts commands

**Files:**
- Create: `src-tauri/src/commands/connection.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/pane.rs` (list_directory 가 SourceId::Ssh 라우팅)
- Modify: `src-tauri/src/lib.rs` (collect_commands + ConnectionPool tauri::State)

각 단계 → 단일 커밋. 4 sub-task 로 나눔:

#### Task 7a: ssh_config_hosts (가장 단순 — SSH 안 함)

```rust
// commands/connection.rs

#[tauri::command]
#[specta::specta]
pub async fn ssh_config_hosts() -> Result<Vec<SshHostEntryDto>, DuetError> {
    let entries = crate::ssh::config::load_ssh_hosts()?;
    Ok(entries.into_iter().map(SshHostEntryDto::from).collect())
}

#[derive(serde::Serialize, specta::Type)]
pub struct SshHostEntryDto {
    pub alias: String,
    pub hostname: String,
    pub port: u16,
    pub user: String,
    pub has_proxy_jump: bool,  // 경로는 노출 안 함
    // identity_files 경로는 일부 시스템에서 user info — 노출 OK 지만 보안 정책에 따라 생략
}

impl From<crate::ssh::config::SshHostEntry> for SshHostEntryDto {
    fn from(e: crate::ssh::config::SshHostEntry) -> Self {
        Self {
            alias: e.alias,
            hostname: e.hostname,
            port: e.port,
            user: e.user,
            has_proxy_jump: !e.proxy_jump.is_empty(),
        }
    }
}
```

`commands/mod.rs` 에 `pub mod connection;` 추가.
`lib.rs` 의 `collect_commands![...]` 에 `commands::connection::ssh_config_hosts` 추가.

```bash
cd src-tauri && cargo check
git add src-tauri/src/commands/
git commit -m "be/cmd: ssh_config_hosts — Sidebar 호스트 목록용

DTO 에서 identity_files / proxy_jump 경로 같은 디테일은 제외 —
프론트엔드는 표시 + 선택만, 자격증명 경로 알 필요 없음 (CLAUDE.md §5)."
```

#### Task 7b: connection_open (인증 분기 + ConnectionPool 등록)

비밀번호 prompt 시 백엔드가 OS native dialog (`tauri-plugin-dialog`) 사용. **프론트엔드로 비밀번호 송수신 절대 X**.

```rust
#[tauri::command]
#[specta::specta]
pub async fn connection_open(
    alias: String,
    pool: tauri::State<'_, std::sync::Arc<crate::services::connection_pool::ConnectionPool>>,
    app: tauri::AppHandle,
) -> Result<crate::types::ConnectionId, DuetError> {
    let host = crate::ssh::config::load_ssh_hosts()?
        .into_iter()
        .find(|h| h.alias == alias)
        .ok_or_else(|| DuetError::ConnectionFailed(format!("alias not found: {alias}")))?;

    // 1. key + agent 시도
    let session = match crate::ssh::connection::connect(&host).await {
        Ok(s) => s,
        Err(DuetError::AuthFailed) => {
            // 2. 비밀번호 prompt — 백엔드에서만 처리
            let password = secure_password_prompt(&app, &alias).await?;
            crate::ssh::connection::connect_with_password(
                &host.hostname, host.port, &host.user, &password,
            ).await?
            // password drops here. tracing 으로 절대 출력 X.
        }
        Err(e) => return Err(e),
    };

    let id = crate::types::ConnectionId(format!("{}:{}", alias, uuid::Uuid::new_v4()));
    let conn = crate::services::connection_pool::ActiveConnection {
        id: id.clone(),
        alias,
        host_ip: session.host_ip,
        user: host.user,
        session: tokio::sync::Mutex::new(session.handle),
    };
    pool.insert(conn).await;
    Ok(id)
}

async fn secure_password_prompt(
    app: &tauri::AppHandle,
    alias: &str,
) -> Result<String, DuetError> {
    // tauri-plugin-dialog 의 input dialog 가 비밀번호 입력 마스킹 가능?
    // tauri 2 의 dialog plugin 은 native input dialog 를 가지지 않음 (file/message 만).
    // 대안: tauri 의 Window::dialog 직접 또는 별도 child window 띄우기.
    // 가장 단순한 MVP-1 방식: backend 가 별도 input window 를 spawn 하고
    //   프론트엔드 password input 컴포넌트를 띄움. but 이러면 입력값이 IPC 로 전달됨.
    //
    // **CLAUDE.md §5 준수 방식**:
    //   - 별도 child window 의 frontend 가 비밀번호 input 받음
    //   - 그 input 은 IPC 로 백엔드에 전달되지만, **그 IPC command 는 ipc.ts 의 일반 commands 에
    //     등록되지 않고**, 별도 채널로 그 child window 에서만 호출 가능
    //   - input 은 메모리에 String 으로만, drop 즉시 zeroize
    //
    // 또는 더 단순: OS native password prompt 를 호출하는 crate (tauri 외부 의존).
    // macOS: `security` CLI / `osascript -e 'display dialog "..." with hidden answer'`
    // Linux: `zenity --password`
    // Windows: PowerShell Get-Credential
    //
    // OS-native CLI 방식이 코드 단순함 + 비밀번호가 child process stdout 으로만 흐름 (IPC 노출 X).
    // 단점: 외부 명령 의존성 (CLAUDE.md 시스템 ssh 호출 금지와 다른 차원 — UI 다이얼로그라 OK).
    unimplemented!("Task 7b 의 secure prompt — 별도 sub-task")
}
```

⚠ Secure prompt 부분이 까다로움. 별도 sub-task 7b-i, 7b-ii 로 나눠서 진행.

```bash
git add ...
git commit -m "be/cmd: connection_open — key/agent fallback + password prompt placeholder

비밀번호 prompt 는 별도 sub-task (CLAUDE.md §5: IPC 노출 X)."
```

#### Task 7c: connection_close + connection_list

```rust
#[tauri::command]
#[specta::specta]
pub async fn connection_close(
    id: crate::types::ConnectionId,
    pool: tauri::State<'_, std::sync::Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<(), DuetError> {
    if let Ok(conn) = pool.get(&id).await {
        let mut session = conn.session.lock().await;
        let _ = session.disconnect(russh::Disconnect::ByApplication, "user closed", "").await;
    }
    pool.remove(&id).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn connection_list(
    pool: tauri::State<'_, std::sync::Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<Vec<ConnectionDto>, DuetError> {
    let active = pool.list().await;
    Ok(active.into_iter().map(|c| ConnectionDto {
        id: c.id.clone(),
        alias: c.alias.clone(),
        host_ip: c.host_ip.to_string(),
        user: c.user.clone(),
    }).collect())
}

#[derive(serde::Serialize, specta::Type)]
pub struct ConnectionDto {
    pub id: crate::types::ConnectionId,
    pub alias: String,
    pub host_ip: String,
    pub user: String,
}
```

#### Task 7d: list_directory SSH 라우팅

`commands/pane.rs` 의 list_directory 갱신 — SourceId::Ssh 처리:

```rust
#[tauri::command]
#[specta::specta]
pub async fn list_directory(
    location: Location,
    pool: tauri::State<'_, std::sync::Arc<crate::services::connection_pool::ConnectionPool>>,
) -> Result<Vec<Entry>, DuetError> {
    match &location.source {
        SourceId::Local => LocalFs::new().list(&location.path).await,
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            crate::fs::ssh::SshFs::new(conn).list(&location.path).await
        }
    }
}
```

`lib.rs`: ConnectionPool 을 `tauri::State` 로 등록:

```rust
let pool = crate::services::connection_pool::ConnectionPool::new();

tauri::Builder::default()
    .manage(pool.clone())
    .plugin(...)
    .invoke_handler(specta_builder.invoke_handler())
    // ...
```

```bash
git commit -m "be/cmd: connection_close/list + list_directory SSH 라우팅

ConnectionPool 을 tauri::State 로 등록. list_directory 가 SourceId::Ssh
면 pool에서 ActiveConnection 가져와서 SshFs::list."
```

---

## Phase E: Frontend — Connections + Sidebar

### Task 8: connections Zustand store + useTauri 통합

**Files:**
- Create: `src/stores/connections.ts`
- Create: `src/stores/connections.test.ts`

```typescript
// src/stores/connections.ts
import { create } from "zustand";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface Host {
  alias: string;
  hostname: string;
  port: number;
  user: string;
  has_proxy_jump: boolean;
}

export interface ActiveConnection {
  id: string;
  alias: string;
  host_ip: string;
  user: string;
  state: ConnectionState;
}

interface ConnectionsState {
  hosts: Host[];                           // ~/.ssh/config 에서 로드
  active: Record<string, ActiveConnection>; // by id
  setHosts: (hosts: Host[]) => void;
  setActive: (id: string, conn: ActiveConnection) => void;
  removeActive: (id: string) => void;
  setState: (id: string, state: ConnectionState) => void;
}

export const useConnections = create<ConnectionsState>((set) => ({
  hosts: [],
  active: {},
  setHosts: (hosts) => set({ hosts }),
  setActive: (id, conn) => set((s) => ({ active: { ...s.active, [id]: conn } })),
  removeActive: (id) => set((s) => {
    const { [id]: _, ...rest } = s.active;
    return { active: rest };
  }),
  setState: (id, state) => set((s) => ({
    active: s.active[id] ? { ...s.active, [id]: { ...s.active[id]!, state } } : s.active,
  })),
}));
```

테스트는 panes.test.ts 패턴 그대로.

```bash
git commit -m "fe/store: connections store (hosts + active)"
```

---

### Task 9: Sidebar 호스트 목록 (placeholder 교체)

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Create: `src/hooks/useSshHosts.ts` — bootstrap에서 ssh_config_hosts 호출

`src/hooks/useSshHosts.ts`:
```typescript
import { useEffect } from "react";
import { commands } from "@/types/bindings";
import { useConnections } from "@/stores/connections";

export function useSshHosts() {
  const setHosts = useConnections((s) => s.setHosts);
  useEffect(() => {
    commands.sshConfigHosts().then((r) => {
      if (r.status === "ok") setHosts(r.data);
    });
  }, [setHosts]);
}
```

App.tsx에서 호출.

Sidebar 의 Hosts 섹션 — 실제 호스트 목록 표시 + 연결 상태 점:
```typescript
function HostsSection() {
  const hosts = useConnections((s) => s.hosts);
  const active = useConnections((s) => s.active);
  // alias → connection state 매핑
  // ...
  return (
    <Section title="Hosts" icon={<Server size={14} />}>
      {hosts.map((h) => (
        <HostItem key={h.alias} host={h} state={...} />
      ))}
    </Section>
  );
}
```

```bash
git commit -m "fe/ui: Sidebar 호스트 목록 + useSshHosts bootstrap"
```

---

### Task 10: ConnectionDialog (새 연결 — alias 더블클릭 시)

**Files:**
- Create: `src/components/connection/ConnectionDialog.tsx`

호스트 더블클릭 → 다이얼로그 열림:
- 호스트 정보 표시 (alias, hostname, port, user)
- "Connect" 버튼 → `commands.connectionOpen({ alias })` 호출
- 성공 시 활성 패널이 SSH 로 전환 (PaneId 선택은 다이얼로그에서)

비밀번호 prompt 가 필요한 경우 → 백엔드가 OS native dialog (Task 7b 의 secure_password_prompt) 띄움. 프론트엔드는 그냥 connectionOpen 결과만 기다림.

shadcn Dialog 가 필요. 처음 사용 — pnpm dlx shadcn-ui@latest add dialog 로 추가 (CLAUDE.md §6: 사용자 승인 후).

```bash
git commit -m "fe/ui: ConnectionDialog — 호스트 더블클릭 → 연결"
```

---

## Phase F: 이벤트 — connection:state + fs:changed

### Task 11: connection:state 이벤트 (백엔드 → 프론트)

**Files:**
- Modify: `src-tauri/src/services/connection_pool.rs` (state 변경 시 emit)
- Modify: `src-tauri/src/lib.rs` (event channel)
- Create: `src/hooks/useConnectionEvents.ts`

```rust
// services/connection_pool.rs 에 추가
pub fn emit_state(app: &tauri::AppHandle, id: &ConnectionId, state: &str) {
    let _ = app.emit("connection:state", serde_json::json!({
        "id": id, "state": state,
    }));
}
```

connection_open / close 에서 emit.

프론트 hook 으로 listen → connections store 갱신.

```bash
git commit -m "be/svc + fe/hook: connection:state 이벤트"
```

---

### Task 12: fs:changed (로컬 notify + SSH stat 폴링)

**Files:**
- Create: `src-tauri/src/services/fs_watcher.rs`
- Modify: `src-tauri/src/lib.rs` (watcher 시작)
- Create: `src/hooks/useFsChangedEvents.ts`

**로컬:** `notify` crate watch on 활성 디렉토리 (panes store 의 location.path 변경 시 watch path 갱신). 변경 감지 → emit `fs:changed`.

**SSH:** 활성 패널의 SSH 디렉토리 mtime 을 3-5초 간격으로 stat. 변경 시 emit. 비활성 패널은 폴링 안 함.

프론트: `fs:changed` 받으면 해당 location 의 list_directory 다시 호출.

```bash
git commit -m "be/svc + fe/hook: fs:changed 이벤트 — notify + SSH 폴링"
```

---

### Task 13: 자동 재연결 + 백오프

**Files:**
- Modify: `src-tauri/src/services/connection_pool.rs`

연결이 끊어지면 (russh handle 의 disconnect 감지) ConnectionPool 이 백오프로 재연결 시도:
- 1초 → 2초 → 4초 → 8초 → 16초 (max 30초)
- N회 실패 시 포기 + connection:state = "error"

```bash
git commit -m "be/svc: 자동 재연결 + 지수 백오프"
```

---

## Phase G: 마무리

### Task 14: 최종 lint/test + ROADMAP 갱신

```bash
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test --lib
cd .. && pnpm tsc --noEmit && pnpm lint && pnpm test --run
```

ROADMAP.md MVP-1 모두 [x] + 현재 단계 갱신:

```
**MVP-2 시작 직전.** MVP-1 완료, 로컬 + 원격 한 곳씩 read-only 탐색 가능.
```

```bash
git commit -m "docs: MVP-1 완료 표시"
```

---

## 자기 점검 (작성자용)

**Spec 커버리지 (ROADMAP MVP-1):**

| ROADMAP 항목 | Task |
|--------------|------|
| russh 통합, ssh/connection.rs | Task 3 |
| ~/.ssh/config 파싱 | Task 1 |
| 키 인증 (key file, agent) | Task 3, 4 |
| 비밀번호 인증 (백엔드 메모리 only) | Task 4, 7b (secure prompt) |
| ProxyJump (russh nested session) | Task 5 |
| SshFs 구현 | Task 6 |
| 사이드바 호스트 목록 + 연결 상태 | Task 9 |
| 새 연결 다이얼로그 | Task 10 |
| 연결 상태 이벤트 (connection:state) | Task 11 |
| 자동 재연결 + 백오프 | Task 13 |
| getpeername() peer IP 캡처 | Task 3 |
| fs:changed (로컬 notify, SSH 폴링) | Task 12 |

**위험 영역:**
- Task 5 (ProxyJump nested session) — russh 0.46 정확한 API 확인 필요. Examples 참고 권장.
- Task 7b (secure password prompt) — IPC 노출 없이 비밀번호 받기. OS native CLI 방식이 가장 단순. 별도 sub-task 로 진행 권장.
- Task 6 (SshFs::list) — russh-sftp 2.0 API. 통합 테스트는 docker compose 가 필요해서 일단 컴파일 only.
- 자격증명 노출 — 모든 Task 에서 `tracing` 출력에 비밀번호/passphrase 들어가지 않는지 review 시 확인.

---

## 실행 핸드오프

Plan complete and saved to `docs/plans/2026-05-09-mvp1-ssh-connection.md`.

**Phase 단위 권장 분할:**
- Session 1: Phase A-C (Task 1-6) — 백엔드 SSH foundation
- Session 2: Phase D (Task 7) — IPC commands + secure password prompt
- Session 3: Phase E-F (Task 8-12) — 프론트엔드 + 이벤트
- Session 4: Phase G (Task 13-14) — 안정성 + 마무리

각 Session 끝에 `pnpm tauri dev` 로 manual 검증.

다음 단계는 subagent-driven-development 로 Task 1부터 진행.
