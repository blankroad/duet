# ARCHITECTURE.md

> 레이어 구조, IPC 경계, 핵심 추상화. 코드 구조에 대한 단일 진실 공급원.

## 큰 그림

```
┌─────────────────────────────────────────────────┐
│  Frontend (React + TypeScript)                  │
│  - UI 렌더링, 사용자 입력 받기                     │
│  - Zustand 스토어로 상태 관리                      │
│  - Tauri command 호출만 (직접 OS API 안 씀)       │
└─────────────────────────────────────────────────┘
                       ↕ IPC (Tauri commands + events)
┌─────────────────────────────────────────────────┐
│  Backend (Rust + Tauri)                         │
│  ┌─────────────────────────────────────────┐    │
│  │  commands/  (IPC 진입점)                  │    │
│  ├─────────────────────────────────────────┤    │
│  │  services/  (앱 서비스 - 작업 큐, 로그)    │    │
│  ├─────────────────────────────────────────┤    │
│  │  core/      (도메인 로직)                  │    │
│  ├─────────────────────────────────────────┤    │
│  │  fs/        (파일시스템 추상화)              │    │
│  │      ┌──────────┬──────────┐            │    │
│  │      │ local    │ ssh      │            │    │
│  │      └──────────┴──────────┘            │    │
│  ├─────────────────────────────────────────┤    │
│  │  platform/  (OS별 분기)                   │    │
│  └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## IPC 경계

**프론트엔드는 백엔드 내부 구조를 모름.** Tauri command만 호출.
**백엔드는 프론트엔드 구조를 모름.** Event 발행 / command 응답만.

### Command 카테고리

```
// connection/* — SSH 연결 관리
connection_open(profile: ConnectionProfile) -> ConnectionId
connection_close(id: ConnectionId) -> ()
connection_list() -> Vec<Connection>

// pane/* — 패널 상태와 디렉토리 리스팅
pane_navigate(pane: PaneId, location: Location) -> ListResult
pane_refresh(pane: PaneId) -> ListResult

// fs/* — 파일 작업 (모두 비동기, 작업 ID 반환)
fs_copy(src: Vec<EntryRef>, dst: Location) -> TaskId
fs_move(src: Vec<EntryRef>, dst: Location) -> TaskId
fs_delete(targets: Vec<EntryRef>, mode: DeleteMode) -> TaskId
fs_rename(target: EntryRef, new_name: String) -> TaskId
fs_mkdir(parent: Location, name: String) -> ()

// task/* — 진행 중 작업 관리
task_list() -> Vec<TaskInfo>
task_cancel(id: TaskId) -> ()

// undo/* — 작업 되돌리기
undo_last() -> UndoResult
undo_history() -> Vec<JournalEntry>

// config/* — 설정
config_get() -> Config
config_set(key: String, value: Value) -> ()
```

### Event (백엔드 → 프론트)

```
task:progress      { task_id, progress, eta }
task:complete      { task_id, result }
task:error         { task_id, error }
fs:changed         { location }     // 외부 변경 감지 (로컬: notify, 원격: 활성 패널 stat 폴링)
connection:state   { id, state }    // SSH 연결 상태 변경
notification       { kind, message } // 사용자 알림
```

### IPC 데이터 타입 (공유)

`src-tauri/src/types/` 와 `src/types/` 양쪽에 미러링.
`specta` + `tauri-specta` crate로 자동 생성 (Rust 타입 + command 시그니처 → TypeScript) 권장.

```rust
// 핵심 타입들
pub enum SourceId {
    Local,
    Ssh {
        connection_id: ConnectionId,
        host_ip: IpAddr,         // getpeername() 결과, 같은-호스트 판정용
        user: String,
    },
}

pub struct Location {
    pub source: SourceId,
    pub path: PathBuf,
}

pub struct EntryRef {
    pub location: Location,
    pub name: String,
}

pub struct Entry {
    pub name: String,
    pub kind: EntryKind,         // File | Dir | Symlink
    pub size: Option<u64>,
    pub modified: Option<DateTime<Utc>>,
    pub permissions: Option<u32>,
}

pub enum DeleteMode {
    Trash,                       // 디폴트
    Permanent,                   // 명시적 활성화 + 추가 확인 필요
}
```

---

## 백엔드 레이어 책임

### `src-tauri/src/commands/`

- Tauri command 함수 (`#[tauri::command]`)
- 입력 검증 (sandbox 검사, 경로 정규화)
- `services/` 호출, 결과를 IPC 친화적 타입으로 변환
- **얇게 유지** — 비즈니스 로직 없음

### `src-tauri/src/services/`

- 앱 수준 서비스
  - `TaskQueue` — 비동기 작업 관리
  - `Journal` — 작업 로그 + undo 데이터
  - `ConnectionPool` — SSH 연결 풀
  - `ConfigStore` — 설정 로드/저장
- `tokio` task 관리, 이벤트 발행
- 실제 파일 작업은 `core/` + `fs/` 호출

### `src-tauri/src/core/`

- 도메인 로직 (OS / 프로토콜 독립)
  - 정렬, 필터링, 검색
  - `DeleteOp`, `CopyOp`, `MoveOp` trait — dry-run + execute 패턴
  - 같은 호스트 감지 (양쪽 패널의 `host_ip` 일치 시 원격 직접 `cp`. user 달라도 OK, 권한 체크 별도)
  - 충돌 정책 (덮어쓰기 → backup 파일 생성)
- **외부 crate 최소화**

### `src-tauri/src/fs/`

- `FileSystem` trait — 파일시스템 추상화
- `LocalFs` — 로컬 파일시스템 (`tokio::fs`)
- `SshFs` — SSH/SFTP (`russh-sftp` 또는 SSH 명령 실행)
- `MockFs` — 테스트용
- 파일시스템 변경 감지 (`notify` crate)

### `src-tauri/src/ssh/`

- SSH 연결 관리 (`russh`) — 시스템 `ssh`/`sftp`/`scp` 명령 호출 금지
- `~/.ssh/config` 파싱 (`ssh2-config` crate)
- 인증 (key file, agent, password)
- ProxyJump 지원 (russh nested session, pure Rust)
- SFTP 채널 + exec 채널 분리 관리
- 연결 직후 `getpeername()` 으로 peer IP 캡처 → `SourceId::Ssh.host_ip`
- 같은 호스트 내 복사 시 `cp` exec
- 원격 휴지통 mv 실패 시 작업 abort (영구삭제 폴백 금지)

### `src-tauri/src/platform/`

- OS별 분기 (`#[cfg(target_os = ...)]`)
- 휴지통 (`trash` crate, OS별 wrapping)
- 드라이브/볼륨 열거
- OS keychain (`keyring` crate)
- 경로 정규화 (macOS NFD)

## 프론트엔드 구조

```
src/
├── App.tsx
├── main.tsx
├── components/
│   ├── ui/                  # shadcn/ui (생성된 컴포넌트)
│   ├── pane/
│   │   ├── Pane.tsx         # 좌/우 패널 메인
│   │   ├── EntryList.tsx    # 파일 리스트 (가상 스크롤)
│   │   ├── EntryRow.tsx
│   │   └── PathBar.tsx      # 상단 경로 표시
│   ├── connection/
│   │   ├── ConnectionList.tsx   # 사이드바 호스트 목록
│   │   └── ConnectionDialog.tsx # 새 연결
│   ├── dialog/
│   │   ├── ConfirmDialog.tsx
│   │   ├── PromptDialog.tsx     # 이름 입력 등
│   │   └── ProgressDialog.tsx
│   ├── statusbar/
│   │   ├── StatusBar.tsx
│   │   └── TaskList.tsx     # 진행 중 작업
│   └── command-palette/
│       └── CommandPalette.tsx   # Ctrl+P 모달
├── stores/
│   ├── panes.ts             # 좌/우 패널 상태
│   ├── connections.ts       # SSH 연결 풀 (프론트 미러)
│   ├── tasks.ts             # 작업 큐 미러
│   ├── config.ts            # 사용자 설정
│   └── ui.ts                # 모달 표시, 활성 패널 등
├── hooks/
│   ├── useTauri.ts          # Tauri command 래퍼
│   ├── useTauriEvent.ts     # event 구독
│   ├── useKeyboard.ts       # 키 바인딩
│   └── useSelection.ts
├── lib/
│   ├── tauri.ts             # 타입 안전 command 호출
│   ├── format.ts            # 사이즈/시간 포맷
│   └── icons.ts             # 파일 타입 아이콘
├── types/
│   └── ipc.ts               # 백엔드와 동기화 (ts-rs 생성)
└── styles/
    └── globals.css          # Tailwind + CSS vars
```

## 핵심 추상화

### FileSystem trait

```rust
#[async_trait]
pub trait FileSystem: Send + Sync {
    fn source_id(&self) -> SourceId;

    async fn list(&self, path: &Path) -> Result<Vec<Entry>>;
    async fn metadata(&self, path: &Path) -> Result<Metadata>;
    async fn read(&self, path: &Path, range: Option<Range<u64>>) -> Result<Bytes>;

    async fn copy(&self, from: &Path, to: &Path, opts: CopyOpts) -> TaskHandle;
    async fn rename(&self, from: &Path, to: &Path) -> Result<()>;
    async fn mkdir(&self, path: &Path) -> Result<()>;
    async fn trash(&self, path: &Path) -> Result<()>;
    async fn remove(&self, path: &Path) -> Result<()>;  // permission 필요

    /// 같은 호스트 내 복사 가능 여부
    fn supports_local_copy(&self, other: &dyn FileSystem) -> bool;

    /// 같은 호스트 내 직접 복사 (네트워크 왕복 없음)
    async fn local_copy(
        &self,
        from: &Path,
        to: &Path,
        other: &dyn FileSystem,
    ) -> Result<TaskHandle>;
}
```

### DeleteOp trait

```rust
pub trait DeleteOp {
    async fn plan(&self) -> Result<DeletePlan>;
    async fn execute(&self, plan: DeletePlan, confirmed: Confirmed) -> Result<JournalEntry>;
}

/// private constructor — 사용자 확인 거친 후에만 발급
pub struct Confirmed(());

pub struct DeletePlan {
    pub mode: DeleteMode,
    pub targets: Vec<EntryRef>,
    pub total_size: u64,
    pub trash_destination: Option<PathBuf>,  // mode == Trash 일 때
}
```

### Journal (undo 시스템)

```rust
pub struct Journal {
    path: PathBuf,  // ~/.duet/journal.jsonl
    cache: VecDeque<JournalEntry>,
}

#[derive(Serialize, Deserialize)]
pub struct JournalEntry {
    pub id: JournalId,
    pub timestamp: DateTime<Utc>,
    pub operation: Operation,
    pub undo: UndoAction,  // 되돌리기 위해 필요한 정보
}

pub enum UndoAction {
    /// trash → 원위치로 mv
    RestoreFromTrash { trash_path: PathBuf, original_path: PathBuf },
    /// 복사 → 복사본 삭제
    DeleteCopy { copied_path: PathBuf },
    /// 이름변경 → 원래 이름으로
    RenameBack { current: PathBuf, original: PathBuf },
    /// 영구삭제는 undo 불가 → undo 시도 시 명시적 실패
    Irreversible,
}
```

### TaskQueue

```rust
pub struct TaskQueue {
    tasks: HashMap<TaskId, Task>,
    tx: mpsc::Sender<TaskEvent>,
}

pub struct Task {
    pub id: TaskId,
    pub kind: TaskKind,    // Copy | Move | Delete | ...
    pub status: TaskStatus,
    pub progress: f32,
    pub cancel: CancellationToken,
}
```

### 에러 타입

```rust
#[derive(thiserror::Error, Debug, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum DuetError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("connection failed: {0}")]
    ConnectionFailed(String),
    #[error("auth failed")]
    AuthFailed,
    #[error("destructive op not permitted")]
    NotPermitted,
    #[error("cancelled")]
    Cancelled,
    #[error("io: {0}")]
    Io(String),
    #[error("ssh: {0}")]
    Ssh(String),
}
```

`Serialize` 필수 — IPC로 프론트엔드에 전달.
`anyhow` 는 `main.rs` / `commands/` 의 외부 호출에서만.

## 비동기 모델

- Tauri 자체가 tokio runtime 위에서 동작
- Command 함수는 `async fn`
- 장기 작업은 `services/TaskQueue` 가 별도 task로 spawn
- 진행률은 `tauri::Window::emit("task:progress", ...)` 로 발행
- 취소는 `CancellationToken`

## 같은 호스트 감지 로직 (핵심 가치)

```rust
// core/copy.rs

pub async fn plan_copy(
    src: &dyn FileSystem,
    dst: &dyn FileSystem,
    items: &[EntryRef],
) -> CopyStrategy {
    match (src.source_id(), dst.source_id()) {
        (SourceId::Local, SourceId::Local) => CopyStrategy::DirectOnHost,
        (
            SourceId::Ssh { host_ip: a, .. },
            SourceId::Ssh { host_ip: b, .. },
        ) if a == b => {
            // 같은 머신 (SSH 연결 직후 getpeername() 으로 잡은 peer IP 일치).
            // user가 달라도 OK — cp 실행 SSH 세션의 user 권한이 src+dst 둘 다 닿아야 함.
            CopyStrategy::DirectOnHost
        }
        _ => CopyStrategy::Relay,  // 본인 PC 거쳐서. 같은 호스트인데 여기로 떨어지면 UI에서 경고.
    }
}
```

`DirectOnHost` 전략은 SSH 채널에서 `cp -r` 또는 `rsync` exec.
**이게 TC 대비 핵심 가치.** 절대 Relay 폴백을 디폴트로 두지 말 것.

같은-호스트 식별 = `getpeername()` 으로 잡은 peer IP 비교.
DNS/alias/`~/.ssh/config` 표기 차이를 모두 흡수.
머신 ID 프로브 (`/etc/machine-id` 등) 는 본인용 도구 범위에서 과함 — 필요해지면 그때 추가.

## 디렉토리 구조

```
duet/
├── Cargo.toml                # 워크스페이스 (선택)
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── index.html
├── README.md
├── ARCHITECTURE.md           ← 이 문서
├── DESIGN.md
├── CLAUDE.md
├── ROADMAP.md
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── commands/
│       ├── services/
│       ├── core/
│       ├── fs/
│       ├── ssh/
│       └── platform/
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   ├── stores/
│   ├── hooks/
│   ├── lib/
│   ├── types/
│   └── styles/
└── config/
    ├── keymap.toml.example
    └── settings.toml.example
```
