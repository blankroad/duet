# `services/` — 앱 서비스

## 책임

앱 수준 서비스. 여러 commands 가 공유하는 상태와 백그라운드 동작.

- `TaskQueue` — 비동기 작업 큐, 진행률 이벤트 발행
- `Journal` — 작업 로그, undo 데이터
- `ConnectionPool` — SSH 연결 풀 (재사용)
- `ConfigStore` — 설정 로드/저장 (`~/.duet/config.toml`)
- `Notifier` — 토스트 / 진행률 이벤트를 프론트로 emit

## 의존성

- 위로: `commands/` 만 호출함
- 아래로: `core/`, `fs/`
- 외부: `tokio`, `tracing`, `serde`

## 하지 말 것

- ❌ 직접 ratatui / 화면 코드 (그건 프론트엔드)
- ❌ 동기 블로킹 호출 (모든 작업은 async)
- ❌ 한 task가 다른 task 직접 await (deadlock 위험)

## 핵심 설계

### TaskQueue

```rust
pub struct TaskQueue {
    tasks: Arc<RwLock<HashMap<TaskId, TaskHandle>>>,
    tx: mpsc::Sender<TaskEvent>,
}

impl TaskQueue {
    pub async fn spawn<T: Task>(&self, task: T) -> TaskId {
        let id = TaskId::new();
        let handle = tokio::spawn(async move { ... });
        // ...
        id
    }
}
```

### Journal (undo 스토어)

```rust
pub struct Journal {
    file: Arc<Mutex<File>>,        // ~/.duet/journal.jsonl 에 append
    cache: Arc<RwLock<VecDeque<JournalEntry>>>,
}

impl Journal {
    pub async fn record(&self, entry: JournalEntry) -> Result<()>;
    pub async fn last(&self) -> Option<JournalEntry>;
    pub async fn undo(&self, entry: &JournalEntry) -> Result<()>;
}
```

### ConnectionPool

```rust
pub struct ConnectionPool {
    connections: Arc<RwLock<HashMap<ConnectionId, SshConnection>>>,
}

// 같은 호스트로 새 연결 요청 시 기존 연결 재사용 (또는 새 channel)
// 연결 끊기면 자동 재연결 + 백오프
```
