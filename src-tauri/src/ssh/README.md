# `ssh/` — SSH 연결 관리

## 책임

- `russh` 기반 SSH 연결
- `~/.ssh/config` 파싱 (`ssh2-config` crate)
- 인증 (key file, ssh-agent, password)
- ProxyJump 지원
- SFTP 채널 + exec 채널 분리 관리
- 같은 호스트 내 복사 시 `cp` exec 실행

## 의존성

- 위로: 없음
- 아래로: `platform/` (keychain, OS-specific)
- 외부: `russh`, `russh-sftp`, `russh-keys`, `ssh2-config`

## 하지 말 것

- ❌ 비밀번호를 로그에 출력 (`Debug` derive 시 주의)
- ❌ 자격증명을 `Result` 의 에러 메시지에 포함
- ❌ 평문 비밀번호 디스크 저장 (`keyring` crate 사용)
- ❌ 호스트 키 검증 우회 (TOFU 모델 + 사용자 확인)

## 핵심 설계

### Connection

```rust
pub struct SshConnection {
    pub id: ConnectionId,
    pub profile: ConnectionProfile,
    handle: russh::client::Handle<ClientHandler>,
    sftp: Mutex<Option<SftpSession>>,
}

impl SshConnection {
    pub async fn connect(profile: ConnectionProfile) -> Result<Self>;
    pub async fn sftp(&self) -> Result<&SftpSession>;

    /// exec 채널로 명령 실행. cp, rm, mkdir 등.
    pub async fn exec(&self, cmd: &str) -> Result<ExecResult>;

    /// 같은 호스트 내 복사 (서버 내부 cp)
    pub async fn local_copy(&self, from: &Path, to: &Path) -> Result<TaskHandle>;
}
```

### 프로필

```rust
pub struct ConnectionProfile {
    pub name: String,           // 사용자 친화적 이름
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub proxy_jump: Option<Box<ConnectionProfile>>,
}

pub enum AuthMethod {
    KeyFile { path: PathBuf, passphrase: Option<SecretString> },
    Agent,
    Password(SecretString),     // 메모리에서만, 절대 디스크 안 가게
}
```

### `~/.ssh/config` 통합

- 시작 시 자동 파싱
- 호스트 별칭 → 자동완성 후보로
- IdentityFile, ProxyJump, User, Port 자동 적용
- 사용자 추가 호스트는 `~/.duet/hosts.toml` 로 별도

## 서브 모듈

```
ssh/
├── mod.rs
├── connection.rs    # SshConnection
├── profile.rs       # ConnectionProfile, AuthMethod
├── ssh_config.rs    # ~/.ssh/config 파싱
├── auth.rs          # 인증 흐름 (agent, key, password)
├── exec.rs          # exec 채널 헬퍼
└── known_hosts.rs   # 호스트 키 검증
```
