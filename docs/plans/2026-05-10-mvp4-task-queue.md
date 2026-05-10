# MVP-4 Implementation Plan: 작업 큐 + 비동기 안정성

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 큰 copy/move 가 background 로 진행되어 UI 가 반응. 호스트당 동시 작업 제어, cancel, 연결 끊김 1회 retry.

**Architecture:** `TaskQueue` (Tauri State) + per-host_key worker (tokio task) FIFO. `core/ops::copy_execute`/`move_execute` 가 `cancel_token` 인자 받아 항목 경계마다 check. `fs_copy_execute`/`fs_move_execute` BREAKING — TaskId 즉시 반환 (현재 JournalId 끝까지 await). ProgressEvent 제거 → TaskEvent::Progress 통합. Frontend tasks store + TasksBar.

**Tech Stack:** Rust (`tokio_util::sync::CancellationToken` 이미 deps, mpsc channel), uuid v7. Frontend (zustand, lucide).

**Spec reference:** `docs/specs/2026-05-10-mvp4-task-queue-design.md`

**현재 상태 (MVP-3 완료):**
- ✅ MVP-3: same-host SSH copy (rsync/cp), CopyStrategy, ProgressEvent
- ✅ 85 lib + 12 integration cargo tests, 22 vitest

**완료 조건 (ROADMAP MVP-4):**
- TaskQueue 서비스 (host_key 별 FIFO worker)
- 진행률 바 (TasksBar — StatusBar 위, DESIGN.md mockup)
- 작업 목록 (TasksBar dropdown when 2+ active)
- 작업 취소 (CancellationToken — 항목 경계 단위)
- 동시 작업 제한 (호스트당 1, 사용자 N개는 후속)
- 실패 시 재시도 (연결 끊김 1회, 3초)

---

## 작업 흐름 가이드

각 Task = 독립 commit. **TDD**: services 레이어 (task_queue, retry) 는 테스트 먼저. core/ops 변경은 인자 추가 (테스트 호환). frontend 는 store 만 테스트.

**커밋 메시지 scope:**
- `be/svc` services/task_queue, services/task_events, services/retry
- `be/core` core/ops cancel + retry 통합
- `be/cmd` commands/fs_ops + commands/tasks
- `fe/store` stores/tasks
- `fe/hook` useTaskEvents
- `fe/ui` TasksBar, ProgressModal Background
- `docs` ROADMAP

**의존성**: 없음. `tokio_util::sync::CancellationToken` 은 tokio_util 안에 있고 이미 deps (Cargo.toml line 25).

---

## Phase A: Foundation (events + queue + retry)

### Task 1: services/task_events.rs

**Files:**
- Create: `src-tauri/src/services/task_events.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Why:** TaskQueue 가 emit 할 typed event + 모든 DTO 타입. 다른 task 들이 import.

- [ ] **Step 1: services/mod.rs 등록**

`src-tauri/src/services/mod.rs` 현재:
```rust
//! 앱 서비스 — 비동기 작업 큐, 저널, 연결 풀, 설정.

pub mod connection_events;
pub mod connection_pool;
pub mod connection_supervisor;
pub mod fs_events;
pub mod fs_watcher;
pub mod journal;
pub mod journal_events;
pub mod progress_events;
pub mod settings;
pub mod trash;
```

→ `progress_events` 제거 (Task 5 에서), `task_events` + `task_queue` + `retry` 추가 (alphabetic):
```rust
//! 앱 서비스 — 비동기 작업 큐, 저널, 연결 풀, 설정.

pub mod connection_events;
pub mod connection_pool;
pub mod connection_supervisor;
pub mod fs_events;
pub mod fs_watcher;
pub mod journal;
pub mod journal_events;
pub mod progress_events;
pub mod retry;
pub mod settings;
pub mod task_events;
pub mod task_queue;
pub mod trash;
```

(이 task 는 `task_events` 만 추가하고, `retry` / `task_queue` 는 Task 2/3 에서 추가. 일단 alphabetic 위치만 잡아 두기 위해 한 번에. 만약 Task 2/3 에서 module 없어 컴파일 에러 나면 일단 `retry` / `task_queue` 라인은 빼고 Task 2/3 에서 add — alphabetic 이니 사이에 끼움.)

**이 Task 에서 실제 mod.rs 갱신**: `task_events` 만 추가:
```rust
//! 앱 서비스 — 비동기 작업 큐, 저널, 연결 풀, 설정.

pub mod connection_events;
pub mod connection_pool;
pub mod connection_supervisor;
pub mod fs_events;
pub mod fs_watcher;
pub mod journal;
pub mod journal_events;
pub mod progress_events;
pub mod settings;
pub mod task_events;
pub mod trash;
```

(`progress_events` 제거는 Task 5. `retry` / `task_queue` 는 Task 2/3 가 alphabetic 자리에 추가.)

- [ ] **Step 2: task_events.rs 작성**

`src-tauri/src/services/task_events.rs`:

```rust
//! TaskQueue 의 typed event + 모든 task DTO.
//!
//! Frontend tasks store 가 listen. ProgressEvent 는 TaskEvent::Progress 로 통합 (Task 5 에서 제거).

use crate::services::journal::JournalId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct TaskId(pub String);

impl TaskId {
    pub fn new() -> Self {
        Self(uuid::Uuid::now_v7().to_string())
    }
}

impl Default for TaskId {
    fn default() -> Self {
        Self::new()
    }
}

/// per-host worker key. 같은 키의 task 는 FIFO 1개씩 처리.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostKey {
    Local,
    Ssh { host_ip: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Copy,
    Move,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Completed { journal_id: JournalId },
    Cancelled,
    Failed { message: String },
}

/// MVP-3 ProgressEvent 의 모양 — TaskEvent::Progress 안에서 재사용.
/// 별도 module 으로 옮기지 않고 task_events 에 inline (사용처가 여기 한 곳).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProgressInfo {
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_sec: Option<u32>,
    /// 0..=100
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TaskDto {
    pub id: TaskId,
    pub kind: TaskKind,
    pub status: TaskStatus,
    /// "Copying foo.zip → /tmp" 같은 표시용 요약.
    pub title: String,
    pub host_key: HostKey,
    pub progress: Option<ProgressInfo>,
    pub error_message: Option<String>,
    /// op 완료 후 frontend 가 refresh 할 location 목록 (보통 src 와 dst).
    /// commands 레이어 (Task 5) 가 enqueue 시 plan.items[0].location + plan.dst 로 채움.
    pub affected_locations: Vec<crate::types::Location>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct TaskEvent {
    pub task_id: TaskId,
    pub change: TaskChange,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskChange {
    Enqueued { task: TaskDto },
    Started,
    Progress { progress: ProgressInfo },
    Completed { journal_id: JournalId },
    Cancelled,
    Failed { message: String },
}
```

- [ ] **Step 3: 컴파일 확인**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri && cargo check --lib --tests
```

기대: clean (이 모듈은 다른 곳에서 아직 사용 안 됨 — declarations only).

- [ ] **Step 4: 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/
git commit -m "be/svc: task_events — TaskId/HostKey/TaskKind/TaskStatus/TaskDto/TaskEvent

MVP-4 의 typed event + 모든 task DTO. ProgressInfo 도 같은 모듈에
inline (사용처 한 곳). TaskQueue (Task 3) 가 emit, frontend tasks store
(Task 6) 가 listen."
```

---

### Task 2: services/retry.rs

**Files:**
- Create: `src-tauri/src/services/retry.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Why:** `is_retryable_error` 헬퍼 — connection loss 만 true. core/ops (Task 4) 가 사용.

- [ ] **Step 1: services/mod.rs 에 추가**

`src-tauri/src/services/mod.rs` 의 alphabetic 위치 (`progress_events` 와 `settings` 사이):

```rust
pub mod progress_events;
pub mod retry;
pub mod settings;
```

- [ ] **Step 2: retry.rs 작성 (테스트 먼저)**

```rust
//! Retry 정책 헬퍼.
//!
//! MVP-4 v1: 연결 끊김만 1회 retry. Exponential backoff 없음 (단순 3초 sleep).

use crate::types::DuetError;

/// 이 에러가 retry-worthy 한가?
///
/// True 케이스:
/// - `ConnectionFailed(_)`: TCP 또는 SSH 핸드셰이크 끊김
/// - `Ssh(msg)` 가 substring "channel closed" / "EOF" / "broken pipe" 포함:
///   exec/sftp 도중 connection drop
///
/// False 케이스 (즉시 fail): AuthFailed, NotFound, PermissionDenied, NotPermitted,
/// Cancelled, NotSupported, Io.
pub fn is_retryable_error(err: &DuetError) -> bool {
    match err {
        DuetError::ConnectionFailed(_) => true,
        DuetError::Ssh(msg) => {
            msg.contains("channel closed")
                || msg.contains("EOF")
                || msg.contains("broken pipe")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_failed_is_retryable() {
        assert!(is_retryable_error(&DuetError::ConnectionFailed("any".into())));
    }

    #[test]
    fn ssh_channel_closed_is_retryable() {
        assert!(is_retryable_error(&DuetError::Ssh(
            "rsync failed (exit 23): channel closed".into()
        )));
    }

    #[test]
    fn ssh_eof_is_retryable() {
        assert!(is_retryable_error(&DuetError::Ssh("EOF on stream".into())));
    }

    #[test]
    fn ssh_broken_pipe_is_retryable() {
        assert!(is_retryable_error(&DuetError::Ssh(
            "write error: broken pipe".into()
        )));
    }

    #[test]
    fn ssh_other_message_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::Ssh("permission denied".into())));
    }

    #[test]
    fn auth_failed_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::AuthFailed));
    }

    #[test]
    fn not_found_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::NotFound("/nope".into())));
    }

    #[test]
    fn cancelled_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::Cancelled));
    }

    #[test]
    fn io_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::Io("permission".into())));
    }

    #[test]
    fn not_supported_is_not_retryable() {
        assert!(!is_retryable_error(&DuetError::NotSupported("MVP-3".into())));
    }
}
```

- [ ] **Step 3: 테스트 + 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri && cargo test --lib services::retry
```

기대: 10 passed.

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/
git commit -m "be/svc: retry — is_retryable_error (connection loss only)

MVP-4 v1 정책: ConnectionFailed + Ssh msg substring (channel closed / EOF
/ broken pipe) 만 true. 나머지 (Auth/NotFound/Permission/Cancelled/Io 등)
즉시 fail. core/ops 가 1회 retry 결정에 사용 (Task 4)."
```

---

### Task 3: services/task_queue.rs

**Files:**
- Create: `src-tauri/src/services/task_queue.rs`
- Modify: `src-tauri/src/services/mod.rs`

**Why:** MVP-4 의 핵심. per-host_key worker FIFO. enqueue/cancel/list API. 실제 op 실행은 Task 5 (commands) 에서 closure 주입 — 이 task 에서는 worker 인프라만.

- [ ] **Step 1: services/mod.rs 에 추가**

`task_events` 와 `trash` 사이:
```rust
pub mod task_events;
pub mod task_queue;
pub mod trash;
```

- [ ] **Step 2: task_queue.rs 작성**

```rust
//! 비동기 작업 큐 (per-host_key FIFO worker).
//!
//! `TaskQueue` 는 Tauri State 로 등록. `enqueue_*` 호출 시:
//! 1. TaskRecord 만들어 inner state 에 보관 (status = Queued)
//! 2. host_key 의 worker 에게 mpsc 로 WorkItem 보냄 (worker 없으면 spawn)
//! 3. `TaskEvent::Enqueued` emit
//!
//! Worker 는 `WorkItem` 받아:
//! - cancel_token 미리 cancel 됐으면 silent skip (이미 cancel emit 됨)
//! - 아니면 status → Running, `Started` emit, run 호출
//! - run 결과: Completed { journal_id } 또는 Failed { message }
//! - 모두 emit 후 state 에서 record 제거
//!
//! `cancel(task_id)`: token.cancel() + (큐 안이면) status → Cancelled + emit.
//! Worker 가 나중에 받았을 때 token check 로 silent skip.

use crate::services::journal::JournalId;
use crate::services::task_events::{
    HostKey, ProgressInfo, TaskChange, TaskDto, TaskEvent, TaskId, TaskKind, TaskStatus,
};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

/// run() 시 caller 가 제공하는 closure. async fn boxed.
///
/// 이 형태로 추상화 — TaskQueue 가 Copy/Move 의 plan 타입을 모르도록
/// (commands 레이어가 plan 을 capture 한 closure 를 넘김).
pub type RunFn = Box<
    dyn FnOnce(
            CancellationToken,
            ProgressEmitter,
        ) -> Pin<
            Box<dyn std::future::Future<Output = Result<JournalId, crate::types::DuetError>> + Send>,
        > + Send,
>;

/// Worker 의 progress emit 채널 — closure 가 호출.
#[derive(Clone)]
pub struct ProgressEmitter {
    app: AppHandle,
    task_id: TaskId,
}

impl ProgressEmitter {
    pub fn emit(&self, p: ProgressInfo) {
        let _ = TaskEvent {
            task_id: self.task_id.clone(),
            change: TaskChange::Progress { progress: p },
        }
        .emit(&self.app);
    }
}

struct WorkItem {
    task_id: TaskId,
    cancel_token: CancellationToken,
    run: RunFn,
}

struct TaskRecord {
    dto: TaskDto,
    cancel_token: CancellationToken,
}

struct Inner {
    workers: HashMap<HostKey, mpsc::UnboundedSender<WorkItem>>,
    tasks: HashMap<TaskId, TaskRecord>,
}

pub struct TaskQueue {
    state: Mutex<Inner>,
    app: AppHandle,
}

impl TaskQueue {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Inner {
                workers: HashMap::new(),
                tasks: HashMap::new(),
            }),
            app,
        })
    }

    /// 새 task 등록 + worker 에게 송신. 즉시 TaskId 반환.
    pub async fn enqueue(
        self: &Arc<Self>,
        kind: TaskKind,
        title: String,
        host_key: HostKey,
        affected_locations: Vec<crate::types::Location>,
        run: RunFn,
    ) -> TaskId {
        let task_id = TaskId::new();
        let cancel_token = CancellationToken::new();
        let dto = TaskDto {
            id: task_id.clone(),
            kind,
            status: TaskStatus::Queued,
            title,
            host_key: host_key.clone(),
            progress: None,
            error_message: None,
            affected_locations,
        };
        let record = TaskRecord {
            dto: dto.clone(),
            cancel_token: cancel_token.clone(),
        };

        // worker 보장 + state insert
        let sender = {
            let mut inner = self.state.lock().await;
            inner.tasks.insert(task_id.clone(), record);
            inner
                .workers
                .entry(host_key.clone())
                .or_insert_with(|| spawn_worker(self.clone()))
                .clone()
        };

        let _ = TaskEvent {
            task_id: task_id.clone(),
            change: TaskChange::Enqueued { task: dto },
        }
        .emit(&self.app);

        let _ = sender.send(WorkItem {
            task_id: task_id.clone(),
            cancel_token,
            run,
        });

        task_id
    }

    /// cancel — token cancel + (큐 안이면) status → Cancelled + emit.
    /// 이미 종결된 task 는 no-op.
    pub async fn cancel(self: &Arc<Self>, task_id: &TaskId) {
        let mut inner = self.state.lock().await;
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return;
        };
        // 이미 종결?
        if matches!(
            record.dto.status,
            TaskStatus::Completed { .. } | TaskStatus::Cancelled | TaskStatus::Failed { .. }
        ) {
            return;
        }
        record.cancel_token.cancel();
        record.dto.status = TaskStatus::Cancelled;
        let _ = TaskEvent {
            task_id: task_id.clone(),
            change: TaskChange::Cancelled,
        }
        .emit(&self.app);
        // record 는 worker 가 wakeup 후 cleanup 해도 되고, 여기서 바로 제거해도 됨.
        // 동시성 단순화 위해 worker cleanup 에 맡김 (worker 가 cancel_token check 후
        // remove). 만약 worker 가 아직 wakeup 안 했어도 list() 에서 보이는 status 는
        // Cancelled 라 frontend 는 정상.
    }

    pub async fn list(&self) -> Vec<TaskDto> {
        self.state
            .lock()
            .await
            .tasks
            .values()
            .map(|r| r.dto.clone())
            .collect()
    }

    /// 내부용 — worker 가 호출. status update + 종결 시 record 제거.
    async fn finalize(&self, task_id: &TaskId, status: TaskStatus) {
        let mut inner = self.state.lock().await;
        if let Some(record) = inner.tasks.get_mut(task_id) {
            record.dto.status = status.clone();
        }
        let change = match &status {
            TaskStatus::Completed { journal_id } => TaskChange::Completed {
                journal_id: journal_id.clone(),
            },
            TaskStatus::Cancelled => TaskChange::Cancelled,
            TaskStatus::Failed { message } => TaskChange::Failed {
                message: message.clone(),
            },
            _ => return, // Queued / Running 은 finalize 아님
        };
        let _ = TaskEvent {
            task_id: task_id.clone(),
            change,
        }
        .emit(&self.app);
        // 종결 후 제거 — frontend 는 이미 event 받음
        inner.tasks.remove(task_id);
    }

    async fn mark_running(&self, task_id: &TaskId) {
        let mut inner = self.state.lock().await;
        if let Some(record) = inner.tasks.get_mut(task_id) {
            record.dto.status = TaskStatus::Running;
        }
        let _ = TaskEvent {
            task_id: task_id.clone(),
            change: TaskChange::Started,
        }
        .emit(&self.app);
    }
}

fn spawn_worker(queue: Arc<TaskQueue>) -> mpsc::UnboundedSender<WorkItem> {
    let (tx, mut rx) = mpsc::unbounded_channel::<WorkItem>();
    tokio::spawn(async move {
        while let Some(item) = rx.recv().await {
            let task_id = item.task_id.clone();
            // Cancelled queued: silent skip (cancel() 이 이미 emit + status update)
            if item.cancel_token.is_cancelled() {
                // record 는 cancel() 가 남겨놨음 — 여기서 제거
                let mut inner = queue.state.lock().await;
                inner.tasks.remove(&task_id);
                continue;
            }
            queue.mark_running(&task_id).await;
            let emitter = ProgressEmitter {
                app: queue.app.clone(),
                task_id: task_id.clone(),
            };
            let result = (item.run)(item.cancel_token.clone(), emitter).await;
            let status = match result {
                Ok(journal_id) => TaskStatus::Completed { journal_id },
                Err(crate::types::DuetError::Cancelled) => TaskStatus::Cancelled,
                Err(e) => TaskStatus::Failed {
                    message: format!("{e}"),
                },
            };
            queue.finalize(&task_id, status).await;
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_app() -> tauri::AppHandle {
        // Tauri AppHandle 없이 단위 테스트 어려움 — 이 모듈은 실제 통합 테스트
        // (mvp4_smoke.rs Task 11) 에서 검증. 컴파일 시그니처만:
        unimplemented!("AppHandle not available in unit test — use mvp4_smoke.rs")
    }

    #[test]
    fn task_queue_signature_compiles() {
        let _ = TaskQueue::new;
        let _ = TaskQueue::enqueue;
        let _ = TaskQueue::cancel;
        let _ = TaskQueue::list;
        let _ = fake_app;
    }
}
```

- [ ] **Step 3: 컴파일 + 테스트**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri && cargo check --lib --tests && cargo test --lib services::task_queue
```

기대: 1 sanity test pass.

- [ ] **Step 4: 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/services/
git commit -m "be/svc: TaskQueue — per-host_key FIFO worker

- enqueue(kind, title, host_key, run): TaskRecord insert + worker spawn-on-demand
  + Enqueued emit + send WorkItem
- cancel(task_id): token.cancel() + status Cancelled + emit (worker silent skip)
- list(): TaskDto snapshot
- spawn_worker: mpsc loop, cancel_token check first, mark_running + run +
  finalize (Completed/Cancelled/Failed)
- ProgressEmitter: closure 가 host worker 안에서 progress 발행
- RunFn: Box<dyn FnOnce(CancellationToken, ProgressEmitter) -> Future>
  — commands 레이어가 plan capture 한 closure 주입 (Task 5)
- 단위 테스트 = 시그니처 sanity (실제 통합은 mvp4_smoke Task 11)"
```

---

## Phase B: core/ops cancellation 통합

### Task 4: copy_execute / move_execute 가 cancel_token 인자 + retry helper

**Files:**
- Modify: `src-tauri/src/core/ops.rs`

**Why:** TaskQueue 가 cancel 하면 op 가 즉시 멈춰야 함. 항목 경계마다 token check + connection loss 시 1회 retry.

- [ ] **Step 1: 시그니처 변경 — 모든 execute 함수에 cancel_token 추가**

`src-tauri/src/core/ops.rs` 의 다음 함수들 시그니처 갱신:

```rust
pub async fn copy_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<JournalEntry, DuetError>
```

같은 인자 추가: `copy_execute_relay`, `copy_execute_same_host`, `move_execute`.

`delete_execute`, `rename`, `mkdir` 는 동기 (TaskQueue scope 외) — 시그니처 안 바꿈.

- [ ] **Step 2: copy_execute_relay 의 항목 loop 에 cancel check + retry**

기존:
```rust
async fn copy_execute_relay(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    let mut copied = Vec::new();
    let mut backups = Vec::new();
    for it in &plan.items {
        let src_path = it.location.path.join(&it.name);
        let dst_path = plan.dst.path.join(&it.name);

        if dst_fs.metadata(&dst_path).await.is_ok() {
            let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path.clone(),
            });
        }

        crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
        copied.push(dst_path);
    }
    // ... journal push
}
```

→ 신규 (cancel check + retry):
```rust
async fn copy_execute_relay(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    let mut copied = Vec::new();
    let mut backups = Vec::new();
    for it in &plan.items {
        // 항목 경계 cancel check
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }

        let src_path = it.location.path.join(&it.name);
        let dst_path = plan.dst.path.join(&it.name);

        // 충돌 시 backup — retry idempotency: 이미 .bak 가 있으면 skip rename
        if dst_fs.metadata(&dst_path).await.is_ok() {
            let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path.clone(),
            });
        }

        // copy 본체 — connection loss 면 1회 retry
        match crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await {
            Ok(()) => {}
            Err(e) if crate::services::retry::is_retryable_error(&e) => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if cancel_token.is_cancelled() {
                    return Err(DuetError::Cancelled);
                }
                crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
            }
            Err(e) => return Err(e),
        }
        copied.push(dst_path);
    }

    let undo = UndoAction::UndoCopy {
        target_source: plan.dst.source.clone(),
        copied,
        backups_to_restore: backups,
    };
    let op = OpKind::Copy {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
}
```

- [ ] **Step 3: copy_execute (dispatcher) 가 token forward**

```rust
pub async fn copy_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<JournalEntry, DuetError> {
    match plan.strategy {
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => {
            copy_execute_relay(src_fs, dst_fs, plan, ctx, cancel_token).await
        }
        CopyStrategy::SshSameHost => copy_execute_same_host(plan, ctx, cancel_token).await,
    }
}
```

- [ ] **Step 4: copy_execute_same_host 도 cancel check + retry**

함수 시그니처에 `cancel_token: CancellationToken` 추가. 기존 항목 loop 시작에 check 추가:

```rust
async fn copy_execute_same_host(
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    // ... (rsync detect + backup loop 부분은 변경 없음 — backup 도 token check)
    
    // (기존 코드의 rsync detect 그대로)
    
    // backup loop 갱신:
    let mut backups = Vec::new();
    for it in &plan.items {
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let dst_path = plan.dst.path.join(&it.name);
        if dst_fs.metadata(&dst_path).await.is_ok() {
            let backup = pick_backup_path(&dst_fs, &plan.dst.path, &it.name).await?;
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path,
            });
        }
    }
    
    // 그 다음 copy loop 도 cancel check + retry:
    let op_id = uuid::Uuid::now_v7().to_string();
    let mut copied = Vec::new();
    
    for it in &plan.items {
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        // ... cmd 구성 ...
        // exec_streaming 호출 부분 — connection loss 면 1회 retry
        let result = run_one_copy(/* args */).await;
        match result {
            Ok(()) => {}
            Err(e) if crate::services::retry::is_retryable_error(&e) => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if cancel_token.is_cancelled() {
                    return Err(DuetError::Cancelled);
                }
                run_one_copy(/* args */).await?;
            }
            Err(e) => return Err(e),
        }
        copied.push(dst_path);
    }
    // ... journal push
}
```

NOTE: same_host_copy 의 retry 는 rsync 가 partial transfer 한 상태에서 다시 시작 — rsync 는 자체로 partial 처리 OK (`-a` 가 incremental). retry 시 backup 은 이미 됐으므로 skip 됨 (dst 에 .bak 가 있음).

이 변경은 same_host_copy 본체가 큰 함수라 careful. 기존 본체를 그대로 두고 위 패턴만 적용.

- [ ] **Step 5: move_execute 도 동일 패턴**

`move_execute` 의 항목 loop 시작에 cancel check, 같은 fs rename / 다른 fs copy_relay+trash 부분에 retry.

```rust
pub async fn move_execute(
    src_fs: &dyn FileSystem,
    dst_fs: &dyn FileSystem,
    plan: MovePlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
) -> Result<JournalEntry, DuetError> {
    if plan.items.is_empty() {
        return Err(DuetError::Io("plan has no items".into()));
    }
    if plan.strategy == CopyStrategy::SshSameHost {
        return Err(DuetError::NotSupported(
            "same-host SSH move: MVP-3 v2 후속".into(),
        ));
    }

    let mut moved = Vec::new();
    let mut backups = Vec::new();
    for it in &plan.items {
        if cancel_token.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        let src_path = it.location.path.join(&it.name);
        let dst_path = plan.dst.path.join(&it.name);

        if dst_fs.metadata(&dst_path).await.is_ok() {
            let backup = pick_backup_path(dst_fs, &plan.dst.path, &it.name).await?;
            dst_fs.rename(&dst_path, &backup).await?;
            backups.push(BackupRestore {
                backup_path: backup,
                original_path: dst_path.clone(),
            });
        }

        if plan.is_same_fs {
            src_fs.rename(&src_path, &dst_path).await?;
        } else {
            // copy + trash, with retry on connection loss
            match crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await {
                Ok(()) => {}
                Err(e) if crate::services::retry::is_retryable_error(&e) => {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if cancel_token.is_cancelled() {
                        return Err(DuetError::Cancelled);
                    }
                    crate::fs::copy_relay(src_fs, &src_path, dst_fs, &dst_path).await?;
                }
                Err(e) => return Err(e),
            }
            let batch_id = crate::services::trash::new_batch_id();
            src_fs.trash(&src_path, &batch_id).await?;
        }
        moved.push(MoveItem {
            src_original: src_path,
            dst_now: dst_path,
        });
    }

    let undo = UndoAction::UndoMove {
        src_source: plan.src_source.clone(),
        dst_source: plan.dst.source.clone(),
        moved,
        backups_to_restore: backups,
    };
    let op = OpKind::Move {
        count: plan.items.len() as u32,
        src: plan.items[0].location.clone(),
        dst: plan.dst.clone(),
    };
    ctx.journal.push(op, undo).await
}
```

- [ ] **Step 6: 기존 테스트 갱신 — cancel_token 인자 추가**

`mod tests` 안에서 `copy_execute(...)` / `move_execute(...)` 호출하는 테스트 모두 마지막 인자 추가:

```rust
let cancel = tokio_util::sync::CancellationToken::new();
ops::copy_execute(&local, &local, plan, &ctx, cancel).await
```

기존 hit:
- `permanent_delete_blocked_when_settings_off` (delete_execute 호출 — 변경 X)
- `rename_works_and_journals` (rename — 변경 X)
- `mkdir_works_and_journals` (mkdir — 변경 X)
- `copy_plan_*` (plan 함수 — 변경 X)
- `copy_plan_same_host_ssh_now_uses_ssh_same_host_strategy` (plan — 변경 X)

실제 execute 호출하는 단위 테스트는 ops.rs 안에 없음 (smoke 만). smoke 는 다음 단계.

- [ ] **Step 7: smoke 테스트 갱신 (`tests/mvp2_smoke.rs`)**

`copy_execute` 호출 hit 모두 cancel_token 인자 추가. `move_execute` 도 같은.

```rust
let cancel = tokio_util::sync::CancellationToken::new();
ops::copy_execute(&local, &local, plan, &env.ctx(), cancel).await.unwrap();
```

- [ ] **Step 8: 컴파일 + 테스트**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo check --lib --tests --bins
cargo test --lib
cargo test --tests
cargo clippy --lib --tests --bins -- -D warnings
```

기대: lib 86+ pass (10 retry tests 추가), integration pass.

- [ ] **Step 9: 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/core/ops.rs src-tauri/tests/mvp2_smoke.rs
git commit -m "be/core: copy_execute/move_execute cancel_token + retry on connection loss

- 시그니처 BREAKING: cancel_token: CancellationToken 인자 추가
- 항목 경계 마다 cancel_token.is_cancelled() check → Err(Cancelled)
- copy_relay (Local/Relay) + same_host_copy + move 의 copy 부분 모두 적용
- is_retryable_error 가 true 면 3초 sleep 후 1회 재시도 — backup rename
  은 이미 됐으면 skip 으로 idempotent
- mvp2_smoke 의 호출처 cancel 인자 추가"
```

---

## Phase C: IPC commands

### Task 5: fs_copy_execute / fs_move_execute BREAKING + tasks_list/cancel commands

**Files:**
- Modify: `src-tauri/src/commands/fs_ops.rs`
- Create: `src-tauri/src/commands/tasks.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Delete: `src-tauri/src/services/progress_events.rs`
- Modify: `src-tauri/src/services/mod.rs` (`progress_events` 제거)
- Modify: `src-tauri/src/core/ops.rs` (`copy_execute_same_host` 의 ProgressEvent.emit 호출 → ProgressEmitter 사용)

**Why:** copy/move 가 background. 새 commands 등록. ProgressEvent 폐기 → TaskEvent::Progress 로.

- [ ] **Step 1: copy_execute_same_host 의 progress emit 통로 변경**

`src-tauri/src/core/ops.rs::copy_execute_same_host` 안에서 `ProgressEvent { ... }.emit(&app)` 부분을 ProgressEmitter 사용으로 변경.

이를 위해 함수 시그니처 또 변경:
```rust
async fn copy_execute_same_host(
    plan: CopyPlan,
    ctx: &OpCtx,
    cancel_token: tokio_util::sync::CancellationToken,
    progress: Option<crate::services::task_queue::ProgressEmitter>,
) -> Result<JournalEntry, DuetError>
```

`ctx.app` 사용하던 ProgressEvent emit 부분을:

```rust
// 기존:
let _ = ProgressEvent { op_id: ..., bytes_done: ..., ... }.emit(&app_for_cb);

// 신규:
if let Some(emitter) = &progress_for_cb {
    emitter.emit(crate::services::task_events::ProgressInfo {
        bytes_done: p.bytes_done,
        bytes_total: if total_bytes > 0 { Some(total_bytes) } else { None },
        speed_bps: Some(p.speed_bps),
        eta_sec: Some(p.eta_sec),
        percent: Some(p.percent),
    });
}
```

상위 dispatcher `copy_execute` 도 progress 인자 받음:
```rust
pub async fn copy_execute(
    ...,
    cancel_token: CancellationToken,
    progress: Option<ProgressEmitter>,
) -> Result<JournalEntry, DuetError> {
    match plan.strategy {
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => {
            // relay 는 progress emit 안 함 (read_full/write_full 라 라인 단위 X) —
            // progress 인자 무시
            copy_execute_relay(src_fs, dst_fs, plan, ctx, cancel_token).await
        }
        CopyStrategy::SshSameHost => {
            copy_execute_same_host(plan, ctx, cancel_token, progress).await
        }
    }
}
```

`move_execute` 도 progress 인자 받음 (현재 same-host SSH move 미지원이라 사용 안 됨, but 시그니처 일관성):
```rust
pub async fn move_execute(
    ...,
    cancel_token: CancellationToken,
    _progress: Option<ProgressEmitter>,
) -> Result<JournalEntry, DuetError>
```

- [ ] **Step 2: ops.rs 의 ProgressEvent import 제거**

`ProgressEvent` 와 `tauri_specta::Event` 의 ProgressEvent 사용처는 위에서 ProgressEmitter 로 갈음. import 정리.

- [ ] **Step 3: services/progress_events.rs 삭제**

```bash
rm /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri/src/services/progress_events.rs
```

`services/mod.rs` 에서 `pub mod progress_events;` 제거.

`lib.rs` 의 `collect_events!` 에서 `services::progress_events::ProgressEvent` 제거 + `services::task_events::TaskEvent` 추가.

- [ ] **Step 4: commands/fs_ops.rs — fs_copy_execute / fs_move_execute BREAKING**

기존:
```rust
#[tauri::command]
#[specta::specta]
pub async fn fs_copy_execute(
    plan: CopyPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    app: tauri::AppHandle,
) -> Result<JournalId, DuetError> {
    let src_fs = fs_for(&plan.src_source, pool.inner()).await?;
    let dst_fs = fs_for(&plan.dst.source, pool.inner()).await?;
    let entry = ops::copy_execute(
        &*src_fs, &*dst_fs, plan,
        &ctx(settings.inner().clone(), journal.inner().clone(), pool.inner().clone(), app.clone()),
    ).await?;
    Ok(emit_pushed(&app, entry))
}
```

→ 신규:
```rust
#[tauri::command]
#[specta::specta]
pub async fn fs_copy_execute(
    plan: CopyPlan,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    settings: tauri::State<'_, Arc<SettingsStore>>,
    journal: tauri::State<'_, Arc<Journal>>,
    queue: tauri::State<'_, Arc<TaskQueue>>,
    app: tauri::AppHandle,
) -> Result<TaskId, DuetError> {
    use crate::services::task_events::{HostKey, TaskKind};
    let host_key = host_key_for_copy(&plan.src_source, &plan.dst.source);
    let title = format_copy_title(&plan);

    let pool_inner = pool.inner().clone();
    let settings_inner = settings.inner().clone();
    let journal_inner = journal.inner().clone();
    let app_for_run = app.clone();
    let plan_for_run = plan;

    // 완료 후 refresh 할 location: src (items[0].location) + dst.
    let mut affected = vec![plan_for_run.dst.clone()];
    if let Some(first) = plan_for_run.items.first() {
        affected.push(first.location.clone());
    }

    let task_id = queue.inner().enqueue(
        TaskKind::Copy,
        title,
        host_key,
        affected,
        Box::new(move |cancel_token, progress| Box::pin(async move {
            let src_fs = fs_for(&plan_for_run.src_source, &pool_inner).await?;
            let dst_fs = fs_for(&plan_for_run.dst.source, &pool_inner).await?;
            let ctx = OpCtx {
                settings: settings_inner,
                journal: journal_inner.clone(),
                pool: Some(pool_inner.clone()),
                app: Some(app_for_run.clone()),
            };
            let entry = ops::copy_execute(
                &*src_fs, &*dst_fs, plan_for_run, &ctx, cancel_token, Some(progress),
            ).await?;
            // emit JournalChangedEvent — 기존 emit_pushed 동일
            let id = entry.id;
            let _ = JournalChangedEvent {
                entry,
                change: "push".into(),
            }.emit(&app_for_run);
            Ok(id)
        })),
    ).await;
    Ok(task_id)
}
```

비슷하게 `fs_move_execute` 도 (TaskKind::Move + format_move_title + ops::move_execute).

- [ ] **Step 5: 헬퍼 — host_key_for_copy + format_copy_title + format_move_title**

같은 파일 (`commands/fs_ops.rs`) 끝에:

```rust
fn host_key_for_copy(
    src: &SourceId,
    dst: &SourceId,
) -> crate::services::task_events::HostKey {
    use crate::services::task_events::HostKey;
    use crate::core::copy_strategy::{decide as decide_strategy, CopyStrategy};
    match decide_strategy(src, dst) {
        CopyStrategy::SshSameHost => match src {
            SourceId::Ssh { host_ip, .. } => HostKey::Ssh {
                host_ip: host_ip.to_string(),
            },
            _ => HostKey::Local, // unreachable — strategy ssh_same_host 면 src 는 Ssh
        },
        CopyStrategy::LocalToLocal | CopyStrategy::Relay => HostKey::Local,
    }
}

fn format_copy_title(plan: &CopyPlan) -> String {
    let n = plan.items.len();
    let first = plan.items.first().map(|i| i.name.as_str()).unwrap_or("?");
    let dst = plan.dst.path.display();
    if n == 1 {
        format!("Copying {first} → {dst}")
    } else {
        format!("Copying {first} and {} more → {dst}", n - 1)
    }
}

fn format_move_title(plan: &MovePlan) -> String {
    let n = plan.items.len();
    let first = plan.items.first().map(|i| i.name.as_str()).unwrap_or("?");
    let dst = plan.dst.path.display();
    if n == 1 {
        format!("Moving {first} → {dst}")
    } else {
        format!("Moving {first} and {} more → {dst}", n - 1)
    }
}
```

- [ ] **Step 6: commands/tasks.rs 신규**

`src-tauri/src/commands/tasks.rs`:

```rust
//! Task IPC commands — list + cancel.

use std::sync::Arc;

use crate::services::task_events::{TaskDto, TaskId};
use crate::services::task_queue::TaskQueue;
use crate::types::DuetError;

#[tauri::command]
#[specta::specta]
pub async fn tasks_list(
    queue: tauri::State<'_, Arc<TaskQueue>>,
) -> Result<Vec<TaskDto>, DuetError> {
    Ok(queue.inner().list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn task_cancel(
    task_id: TaskId,
    queue: tauri::State<'_, Arc<TaskQueue>>,
) -> Result<(), DuetError> {
    queue.inner().cancel(&task_id).await;
    Ok(())
}
```

`commands/mod.rs` 에 `pub mod tasks;` 추가.

- [ ] **Step 7: lib.rs — TaskQueue manage + collect_commands + collect_events**

`make_specta_builder()` 의 `commands(collect_commands![...])` 에 추가:
```rust
commands::tasks::tasks_list,
commands::tasks::task_cancel,
```

`collect_events!` 갱신:
```rust
.events(collect_events![
    services::connection_events::ConnectionStateEvent,
    services::fs_events::FsChangedEvent,
    services::journal_events::JournalChangedEvent,
    services::task_events::TaskEvent,
    // services::progress_events::ProgressEvent,  // ← 제거
])
```

`run()` 의 setup 부분에 TaskQueue 생성 + manage:

```rust
.setup(move |app| {
    specta_builder.mount_events(app);
    let watcher = services::fs_watcher::FsWatcher::new(app.handle().clone())
        .expect("fs watcher init");
    app.manage(watcher);
    // MVP-4: TaskQueue
    let task_queue = services::task_queue::TaskQueue::new(app.handle().clone());
    app.manage(task_queue);
    Ok(())
})
```

- [ ] **Step 8: bindings 재생성 + 컴파일 + 테스트**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo run --bin export_bindings
cargo check --lib --tests --bins
cargo test --lib
cargo test --tests
cargo clippy --lib --tests --bins -- -D warnings
```

기대:
- bindings.ts: `progressEvent` 사라지고 `taskEvent` 추가, `tasksList`/`taskCancel` 함수, `TaskDto`/`TaskEvent`/`HostKey`/`TaskKind`/`TaskStatus`/`TaskChange`/`TaskId` 타입.
- fs_copy_execute/fs_move_execute 반환 타입 `TaskId` (기존 `JournalId`).
- 모든 테스트 pass.

- [ ] **Step 9: 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && cargo fmt --manifest-path src-tauri/Cargo.toml
git add src-tauri/src/ src/types/bindings.ts
git commit -m "be/cmd + lib: fs_copy/move_execute BREAKING + tasks commands + ProgressEvent → TaskEvent

- fs_copy_execute / fs_move_execute: TaskQueue.enqueue → 즉시 TaskId 반환
  (이전: JournalId 끝까지 await)
- enqueue closure 가 plan + ctx 캡처, 워커가 cancel/progress emit 처리
- host_key_for_copy: strategy 기반 (SshSameHost → Ssh(host_ip), 그 외 Local)
- format_copy/move_title: 'Copying foo → /tmp' 또는 'and N more'
- 신규 commands/tasks.rs: tasks_list / task_cancel
- copy_execute_same_host: ProgressEvent → ProgressEmitter 통과
- services/progress_events.rs 삭제
- lib.rs: TaskEvent 등록, ProgressEvent 제거, TaskQueue manage in setup"
```

---

## Phase D: Frontend

### Task 6: stores/tasks.ts + tests

**Files:**
- Create: `src/stores/tasks.ts`
- Create: `src/stores/tasks.test.ts`

```typescript
// src/stores/tasks.ts
import { create } from "zustand";
import type { TaskDto, ProgressInfo, TaskStatus } from "@/types/bindings";

interface State {
  tasks: Map<string, TaskDto>;
  add: (t: TaskDto) => void;
  setStatus: (id: string, status: TaskStatus) => void;
  setProgress: (id: string, progress: ProgressInfo) => void;
  setError: (id: string, message: string) => void;
  remove: (id: string) => void;
  setAll: (ts: TaskDto[]) => void;
}

export const useTasks = create<State>((set) => ({
  tasks: new Map(),
  add: (t) =>
    set((s) => {
      const next = new Map(s.tasks);
      next.set(t.id, t);
      return { tasks: next };
    }),
  setStatus: (id, status) =>
    set((s) => {
      const cur = s.tasks.get(id);
      if (!cur) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...cur, status });
      return { tasks: next };
    }),
  setProgress: (id, progress) =>
    set((s) => {
      const cur = s.tasks.get(id);
      if (!cur) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...cur, progress });
      return { tasks: next };
    }),
  setError: (id, message) =>
    set((s) => {
      const cur = s.tasks.get(id);
      if (!cur) return s;
      const next = new Map(s.tasks);
      next.set(id, { ...cur, error_message: message });
      return { tasks: next };
    }),
  remove: (id) =>
    set((s) => {
      if (!s.tasks.has(id)) return s;
      const next = new Map(s.tasks);
      next.delete(id);
      return { tasks: next };
    }),
  setAll: (ts) =>
    set(() => {
      const next = new Map<string, TaskDto>();
      for (const t of ts) next.set(t.id, t);
      return { tasks: next };
    }),
}));

/** Active = queued | running. UI 가 사용. */
export function selectActive(map: Map<string, TaskDto>): TaskDto[] {
  return Array.from(map.values()).filter(
    (t) => t.status.kind === "queued" || t.status.kind === "running",
  );
}
```

테스트:

```typescript
// src/stores/tasks.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useTasks, selectActive } from "./tasks";
import type { TaskDto } from "@/types/bindings";

const mk = (id: string, status: TaskDto["status"] = { kind: "queued" }): TaskDto =>
  ({
    id,
    kind: "copy",
    status,
    title: `task-${id}`,
    host_key: { kind: "local" },
    progress: null,
    error_message: null,
  }) as unknown as TaskDto;

describe("tasks store", () => {
  beforeEach(() => useTasks.setState({ tasks: new Map() }));

  it("add and remove", () => {
    useTasks.getState().add(mk("a"));
    expect(useTasks.getState().tasks.size).toBe(1);
    useTasks.getState().remove("a");
    expect(useTasks.getState().tasks.size).toBe(0);
  });

  it("setStatus updates only matching id", () => {
    useTasks.getState().add(mk("a"));
    useTasks.getState().setStatus("a", { kind: "running" });
    expect(useTasks.getState().tasks.get("a")?.status.kind).toBe("running");
    useTasks.getState().setStatus("missing", { kind: "running" });
    // no-op, no throw
  });

  it("setProgress updates only matching id", () => {
    useTasks.getState().add(mk("a"));
    useTasks.getState().setProgress("a", {
      bytes_done: 100, bytes_total: 200, speed_bps: 50, eta_sec: 2, percent: 50,
    });
    expect(useTasks.getState().tasks.get("a")?.progress?.percent).toBe(50);
  });

  it("selectActive filters queued+running", () => {
    useTasks.getState().add(mk("q", { kind: "queued" }));
    useTasks.getState().add(mk("r", { kind: "running" }));
    useTasks.getState().add(mk("c", { kind: "completed", journal_id: "x" } as any));
    useTasks.getState().add(mk("f", { kind: "failed", message: "x" } as any));
    const active = selectActive(useTasks.getState().tasks);
    expect(active.length).toBe(2);
    expect(active.map((t) => t.id).sort()).toEqual(["q", "r"]);
  });

  it("setAll replaces map", () => {
    useTasks.getState().add(mk("a"));
    useTasks.getState().setAll([mk("b"), mk("c")]);
    expect(useTasks.getState().tasks.size).toBe(2);
    expect(useTasks.getState().tasks.has("a")).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 + 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && pnpm test --run src/stores/tasks.test.ts
```

기대: 5 pass.

```bash
git add src/stores/tasks.ts src/stores/tasks.test.ts
git commit -m "fe/store: tasks store (Map<TaskId, TaskDto>) + selectActive

add/setStatus/setProgress/setError/remove/setAll. selectActive 셀렉터:
status queued|running 만. 5 vitest pass."
```

---

### Task 7: useTaskEvents hook

**Files:**
- Create: `src/hooks/useTaskEvents.ts`

```typescript
import { useEffect } from "react";
import { events, commands } from "@/types/bindings";
import { useTasks } from "@/stores/tasks";

/**
 * 백엔드 task-event 구독 + 부트스트랩.
 *
 * - 마운트 시 tasks_list 로 현재 큐 snapshot 받아 store init
 * - 이후 TaskEvent 수신:
 *   - Enqueued{task} → add
 *   - Started → setStatus running
 *   - Progress{progress} → setProgress
 *   - Completed{journal_id} → setStatus completed → remove (즉시)
 *   - Cancelled → setStatus cancelled → remove
 *   - Failed{message} → setStatus failed + setError → remove
 *
 * 종결 상태 (completed/cancelled/failed) 는 즉시 store 에서 remove —
 * TasksBar 가 active 만 표시. history 보존은 후속 (MVP-7).
 */
export function useTaskEvents() {
  const setAll = useTasks((s) => s.setAll);
  const add = useTasks((s) => s.add);
  const setStatus = useTasks((s) => s.setStatus);
  const setProgress = useTasks((s) => s.setProgress);
  const setError = useTasks((s) => s.setError);
  const remove = useTasks((s) => s.remove);

  // bootstrap
  useEffect(() => {
    let cancelled = false;
    commands.tasksList().then((r) => {
      if (cancelled) return;
      if (r.status === "ok") setAll(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, [setAll]);

  // live subscribe
  useEffect(() => {
    const unlistenP = events.taskEvent.listen(({ payload }) => {
      const id = payload.task_id;
      switch (payload.change.kind) {
        case "enqueued":
          add(payload.change.task);
          break;
        case "started":
          setStatus(id, { kind: "running" });
          break;
        case "progress":
          setProgress(id, payload.change.progress);
          break;
        case "completed":
          setStatus(id, { kind: "completed", journal_id: payload.change.journal_id });
          remove(id);
          break;
        case "cancelled":
          setStatus(id, { kind: "cancelled" });
          remove(id);
          break;
        case "failed":
          setError(id, payload.change.message);
          setStatus(id, { kind: "failed", message: payload.change.message });
          remove(id);
          break;
      }
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, [add, setStatus, setProgress, setError, remove]);
}
```

- [ ] **Step 2: 컴파일 확인 + 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && pnpm tsc --noEmit && pnpm lint
```

기대: clean.

```bash
git add src/hooks/useTaskEvents.ts
git commit -m "fe/hook: useTaskEvents — bootstrap (tasks_list) + listen TaskEvent

종결 상태는 즉시 remove — TasksBar 가 active 만 표시. history 보존
후속 (MVP-7)."
```

---

### Task 8: ui-dialogs progress 변경 + ProgressModal Background 버튼 + useProgressEvents 제거

**Files:**
- Modify: `src/stores/ui-dialogs.ts`
- Modify: `src/stores/ui-dialogs.test.ts`
- Modify: `src/components/dialogs/ProgressModal.tsx`
- Delete: `src/hooks/useProgressEvents.ts`

- [ ] **Step 1: ui-dialogs 의 progress dialog 변경**

`src/stores/ui-dialogs.ts` — `ProgressInfo` interface 와 `setProgress` action 제거. progress dialog variant 변경:

```typescript
import { create } from "zustand";
import type { CopyPlan, DeletePlan, MovePlan, EntryRef, Location } from "@/types/bindings";

export type DialogState =
  | { kind: "none" }
  | { kind: "rename"; target: EntryRef }
  | { kind: "mkdir"; parent: Location }
  | { kind: "delete-confirm"; plan: DeletePlan }
  | { kind: "delete-danger"; plan: DeletePlan }
  | { kind: "copy-confirm"; plan: CopyPlan }
  | { kind: "move-confirm"; plan: MovePlan }
  | { kind: "progress"; title: string; taskId: string }  // ← progress 필드 제거, taskId 추가
  | { kind: "settings" };

interface State {
  dialog: DialogState;
  open: (d: DialogState) => void;
  close: () => void;
}

export const useUIDialogs = create<State>((set) => ({
  dialog: { kind: "none" },
  open: (d) => set({ dialog: d }),
  close: () => set({ dialog: { kind: "none" } }),
}));
```

`ProgressInfo` 가 필요한 곳 (ProgressModal) 은 `@/types/bindings` 에서 직접 import.

- [ ] **Step 2: ui-dialogs.test.ts — setProgress 테스트 제거**

기존 `it("setProgress updates progress on progress dialog only", ...)` 테스트 제거. 다른 테스트 (open/close, replace) 는 유지하되, `progress` 다이얼로그 open 시 `taskId` 인자 필요 갱신:

```typescript
it("opens and closes", () => {
  useUIDialogs.getState().open({ kind: "settings" });
  expect(useUIDialogs.getState().dialog.kind).toBe("settings");
  useUIDialogs.getState().close();
  expect(useUIDialogs.getState().dialog.kind).toBe("none");
});

it("only one dialog at a time — open replaces", () => {
  useUIDialogs.getState().open({ kind: "settings" });
  useUIDialogs.getState().open({ kind: "progress", title: "x", taskId: "tid" });
  expect(useUIDialogs.getState().dialog.kind).toBe("progress");
});
```

- [ ] **Step 3: ProgressModal — taskId 기반 + Background 버튼**

`src/components/dialogs/ProgressModal.tsx`:

```tsx
import * as Dialog from "@radix-ui/react-dialog";
import { Loader, X } from "lucide-react";
import { formatSize } from "@/lib/format";
import { useTasks } from "@/stores/tasks";
import type { ProgressInfo } from "@/types/bindings";

export function ProgressModal({
  title,
  taskId,
  onBackground,
}: {
  title: string;
  taskId: string;
  onBackground: () => void;
}) {
  // 백엔드 task 가 종결되면 store 에서 remove → undefined.
  // ProgressModal 은 그 경우 자동 close 해야 함 — onBackground 호출.
  const task = useTasks((s) => s.tasks.get(taskId));
  const progress = task?.progress ?? null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onBackground()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md border border-border bg-base p-4 shadow-lg focus:outline-none"
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
        >
          <div className="mb-3 flex items-start justify-between gap-2">
            <Dialog.Title className="text-title font-medium">{title}</Dialog.Title>
            <button
              type="button"
              onClick={onBackground}
              className="rounded p-1 text-fg-muted hover:bg-border"
              aria-label="Background"
              title="Run in background"
            >
              <X size={14} />
            </button>
          </div>

          {progress ? <ProgressBody p={progress} /> : <SpinnerBody />}

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={onBackground}
              className="rounded border border-border px-3 py-1 text-base hover:bg-subtle"
            >
              Background
            </button>
          </div>

          <Dialog.Description className="sr-only">{title}</Dialog.Description>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SpinnerBody() {
  return (
    <div className="mt-3 flex items-center gap-2 text-base text-fg-muted">
      <Loader size={14} className="animate-spin" />
      <span>Working…</span>
    </div>
  );
}

function ProgressBody({ p }: { p: ProgressInfo }) {
  const pct = p.percent ?? 0;
  return (
    <div className="mt-3 space-y-2">
      <div className="h-2 w-full overflow-hidden rounded bg-subtle">
        <div
          className="h-full bg-accent transition-all"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
      <div className="flex justify-between text-meta text-fg-muted">
        <span>
          {formatSize(p.bytes_done)}
          {p.bytes_total ? ` / ${formatSize(p.bytes_total)}` : ""}
        </span>
        <span>
          {p.speed_bps ? `${formatSize(p.speed_bps)}/s` : ""}
          {p.eta_sec != null ? ` · ETA ${formatEta(p.eta_sec)}` : ""}
        </span>
      </div>
    </div>
  );
}

function formatEta(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
```

- [ ] **Step 4: useProgressEvents.ts 삭제**

```bash
rm /Users/ctmctm/Desktop/01_PROJECT/duet/src/hooks/useProgressEvents.ts
```

- [ ] **Step 5: tsc + lint + 테스트 + 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet && pnpm tsc --noEmit
```

기대: App.tsx 의 `useProgressEvents()` 호출 + `ProgressModal title progress` prop 사용처에서 에러. **이는 Task 10 (App 통합) 가 해결**. 이 task 만으로는 컴파일 에러 OK 가능.

만약 Task 8 단독 commit 하려면 임시로 App.tsx 의 useProgressEvents 호출 제거 + ProgressModal 호출에 taskId stub 전달. 사실 Task 10 직전이라 Task 8 + 9 + 10 을 한 commit 으로 처리하는 게 현실적.

→ **분기**: Task 8/9/10 한 commit 이지만, 작업 단위는 separate. Task 10 시점에 일괄 commit.

대안: Task 8 끝에서 `git stash` 또는 commit 하지 않고 Task 10 까지 진행. 본 plan 에서는 **Task 8/9/10 묶어 한 commit** 으로 가자.

```bash
# (Task 10 의 commit 까지 stash 또는 working state 유지 — 별도 commit 안 함.)
```

**또는** 이 task 의 commit 스코프 좁히기: Task 8 에서 ui-dialogs + ProgressModal 만 변경, App.tsx 컴파일 에러 발생. Task 9/10 즉시 진행하여 한 흐름. cargo/pnpm 통과는 Task 10 끝에.

이 plan 은 Task 10 의 commit 메시지가 Task 8/9/10 모두 포함하도록 진행. Task 8/9 는 working state 만.

이 task 끝에서 commit X. 다음 task 들로 계속.

---

### Task 9: TasksBar component

**Files:**
- Create: `src/components/TasksBar.tsx`

```tsx
import { useState } from "react";
import { Loader, X, ChevronDown, ChevronUp } from "lucide-react";
import { commands } from "@/types/bindings";
import type { TaskDto } from "@/types/bindings";
import { useTasks, selectActive } from "@/stores/tasks";
import { formatSize } from "@/lib/format";

/**
 * StatusBar 위 진행률 바 (DESIGN.md mockup):
 * `⠋ Copying foo.zip → /tmp/  ████░░░  40%   [3 tasks ▼]`
 *
 * - active 0: hidden
 * - active 1: mini progress + Cancel
 * - active 2+: 첫 task summary + dropdown 토글
 */
export function TasksBar() {
  const tasks = useTasks((s) => s.tasks);
  const [expanded, setExpanded] = useState(false);
  const active = selectActive(tasks);

  if (active.length === 0) return null;

  if (active.length === 1) {
    return (
      <div className="flex h-7 items-center gap-2 border-t border-border bg-subtle px-3 text-meta">
        <TaskRow task={active[0]!} />
      </div>
    );
  }

  // 2+
  return (
    <div className="border-t border-border bg-subtle">
      <div className="flex h-7 items-center gap-2 px-3 text-meta">
        <Loader size={11} className="animate-spin text-fg-muted" />
        <span className="truncate text-fg">{active[0]!.title}</span>
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="ml-auto flex items-center gap-1 rounded px-2 py-0.5 hover:bg-border"
        >
          {active.length} tasks
          {expanded ? <ChevronDown size={11} /> : <ChevronUp size={11} />}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border px-3 py-1">
          {active.map((t) => (
            <div key={t.id} className="py-0.5">
              <TaskRow task={t} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: TaskDto }) {
  const pct = task.progress?.percent ?? 0;
  return (
    <div className="flex flex-1 items-center gap-2">
      <Loader size={11} className="shrink-0 animate-spin text-fg-muted" />
      <span className="truncate text-fg">{task.title}</span>
      {task.progress && (
        <>
          <div className="h-1 w-24 shrink-0 overflow-hidden rounded bg-border">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
            />
          </div>
          <span className="shrink-0 text-fg-muted">
            {formatSize(task.progress.bytes_done)}
            {task.progress.bytes_total ? ` / ${formatSize(task.progress.bytes_total)}` : ""}
          </span>
        </>
      )}
      <button
        type="button"
        onClick={() => commands.taskCancel(task.id)}
        className="ml-auto shrink-0 rounded p-0.5 text-fg-muted hover:bg-border hover:text-danger"
        aria-label="Cancel task"
        title="Cancel task"
      >
        <X size={11} />
      </button>
    </div>
  );
}
```

- [ ] commit 안 함 (Task 10 일괄).

---

### Task 10: App.tsx 통합 + Phase D 일괄 commit

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: App.tsx 갱신**

변경점:
- `useProgressEvents` import + 호출 제거 → `useTaskEvents` import + 호출
- `ProgressModal` 호출: `title + taskId + onBackground` 로 변경
- `ProgressInfo` import 제거 (ui-dialogs 에서 빠짐)
- onCopy/MoveConfirm 흐름 변경: TaskId 받은 직후 `openDialog({ kind: "progress", title, taskId })` — 이전엔 await 끝까지
- TaskQueue 가 비동기로 `JournalChangedEvent` emit 하니 `refreshAffected` 는 `useJournalEvents` 에서 자동? 아니 — refresh 는 TaskCompleted 시점에 onRefresh. `useTaskEvents` 안에서 directly call refreshAffected 는 hook deps 문제. 별도 설계 필요.

**Refresh on completion 디자인**: `useTaskEvents` 가 store 만 update. App.tsx 가 `useEffect(() => { ... watch tasks... })` 로 task removal 감지 → completion 시 refresh. 또는 useTasks 의 setStatus 호출 직전에 refresh callback.

가장 단순: `useTaskEvents(refresh: (locations: Location[]) => void)` 시그니처 변경 — completed 시 plan.dst 등 정보 알아야 refresh. 하지만 useTaskEvents 는 task DTO 만 알고 plan 안 가짐.

대안: TaskCompleted 시 backend 가 별도로 `fs-changed-event` 도 emit. `useFsChangedEvents` 가 받아 refresh. 이미 fs_watcher 가 있으니 자연스럽게 동작? 같은 host 의 디렉토리 변경 감지 — local 은 notify, ssh 는 stat 폴링 (3s). 폴링 타이밍 의존.

가장 확실한 방법: `JournalChangedEvent` 를 `useJournalEvents` 가 받음 — entry 의 `op.kind: "Copy"` 면 entry.op.dst 을 알고 그 location refresh. 기존 useJournalEvents 를 확장.

또는 단순화: TaskEvent::Completed 시 `commands.tasksList` 후 refresh 가 없으면 5초마다 panel refresh. 너무 미신.

**최종 선택**: useTaskEvents 가 refreshAffected 콜백 받기. App 에서 onRefresh + refreshAffected 함수 정의 + plan 정보를 task 에 보관.

문제는 task DTO 가 plan 안 들고 — title 만 있음. host_key 만으로 refresh location 알 수 없음 (한 호스트의 어느 path 인지 모름).

해결: `TaskDto` 에 `affected_locations: Vec<Location>` 추가 (plan 만들 때 dst 포함, src 도). 또는 backend 가 TaskCompleted event payload 에 location 포함.

이 plan 에서는 **TaskDto 에 affected_locations 추가** — backend Task 1 (task_events) 시점에 포함:

```rust
pub struct TaskDto {
    // 기존 +
    pub affected_locations: Vec<Location>,
}
```

Wait — this is changing Task 1 retroactively. Add to Task 1 design.

**DECISION: Plan 의 Task 1 에 affected_locations 추가하고, 본 Task (10) 에서 사용.**

(plan 작성 중인 만큼, Task 1 spec 에 이 필드 포함.)

본 task 의 App.tsx 갱신:

```tsx
import { useTaskEvents } from "@/hooks/useTaskEvents";
import { TasksBar } from "@/components/TasksBar";

// hook 호출:
useTaskEvents(refreshAffected);

// ... ProgressModal 호출:
{dialog.kind === "progress" && (
  <ProgressModal
    title={dialog.title}
    taskId={dialog.taskId}
    onBackground={closeDialog}
  />
)}

// ... TasksBar 배치 (StatusBar 위):
<TasksBar />
<StatusBar />

// onCopyConfirm:
const onCopyConfirm = useCallback(async () => {
  if (dialog.kind !== "copy-confirm") return;
  const plan = dialog.plan;
  const r = await commands.fsCopyExecute(plan);
  if (r.status === "ok") {
    openDialog({ kind: "progress", title: "Copying…", taskId: r.data });
  } else {
    closeDialog();
    showToast(`Copy failed: ${formatErr(r.error)}`);
  }
}, [dialog, openDialog, closeDialog, showToast]);
```

(refreshAffected 호출은 useTaskEvents 안에서 task.affected_locations 사용해 자동. App 의 onCopyConfirm 은 직접 refresh 안 함.)

**`useTaskEvents` 갱신** (Task 7 의 hook 에 refreshAffected 콜백 추가):

```typescript
export function useTaskEvents(refresh: (locations: Location[]) => void) {
  // ... 기존 + completion 시:
  case "completed":
    setStatus(id, { kind: "completed", journal_id: payload.change.journal_id });
    const task = useTasks.getState().tasks.get(id);
    if (task) refresh(task.affected_locations);
    remove(id);
    break;
}
```

(useTasks.getState() 로 task 가져와서 affected_locations 사용 — store 가 still has it 직전.)

- [ ] **Step 2: tsc + lint + 모든 테스트**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm tsc --noEmit
pnpm lint
pnpm test --run
```

기대: 모두 통과.

- [ ] **Step 3: Phase D 일괄 commit (Task 8/9/10 변경 모두)**

```bash
git add src/App.tsx \
  src/components/TasksBar.tsx \
  src/components/dialogs/ProgressModal.tsx \
  src/stores/ui-dialogs.ts \
  src/stores/ui-dialogs.test.ts \
  src/hooks/useTaskEvents.ts
git rm src/hooks/useProgressEvents.ts
git commit -m "fe: Phase D — useTaskEvents + TasksBar + ProgressModal Background

- ui-dialogs: progress dialog 'taskId' 보유 (이전 progress 객체 → tasks store
  에서 useTaskById 로 가져옴). setProgress action 제거.
- ProgressModal: taskId prop, onBackground 콜백, 'Background' 버튼 명시.
  task 종결 시 store remove → modal 자동 close (onOpenChange).
- TasksBar: StatusBar 위 영역. active 0 → hidden, 1 → mini progress + Cancel,
  2+ → first summary + [N tasks ▼] expandable.
- App.tsx: useTaskEvents(refreshAffected) — TaskCompleted 시 자동 refresh
  using task.affected_locations. onCopy/MoveConfirm: TaskId 받자마자
  openDialog progress (await 끝까지 X).
- useProgressEvents.ts 삭제."
```

---

## Phase E: Smoke + 마무리

### Task 11: tests/mvp4_smoke.rs

**Files:**
- Create: `src-tauri/tests/mvp4_smoke.rs`

TaskQueue 통합 테스트는 Tauri AppHandle 가 필요해 어려움. 여기서는 retry helper + TaskQueue 의 enqueue → list 사이클 (AppHandle mock 안 쓰고 task_queue 의 list/cancel 만 검증) — 어려우면 retry 만 smoke.

실용적 smoke:
- `is_retryable_error` 6 case 검증 (이미 unit 에 있지만 smoke 로도)
- TaskKind/TaskStatus serde round-trip (typed event 정합성)

```rust
//! MVP-4 smoke tests — retry policy + task DTO serde 정합성.
//!
//! 실제 TaskQueue 통합 (enqueue → 워커 → completion) 은 Tauri AppHandle 필요해 후속.

use duet_lib::services::retry::is_retryable_error;
use duet_lib::services::task_events::{
    HostKey, ProgressInfo, TaskDto, TaskId, TaskKind, TaskStatus,
};
use duet_lib::services::journal::JournalId;
use duet_lib::types::DuetError;
use std::path::PathBuf;

#[test]
fn smoke_retry_matrix() {
    assert!(is_retryable_error(&DuetError::ConnectionFailed("x".into())));
    assert!(is_retryable_error(&DuetError::Ssh("channel closed".into())));
    assert!(is_retryable_error(&DuetError::Ssh("EOF".into())));
    assert!(is_retryable_error(&DuetError::Ssh("broken pipe".into())));
    assert!(!is_retryable_error(&DuetError::AuthFailed));
    assert!(!is_retryable_error(&DuetError::NotFound("x".into())));
    assert!(!is_retryable_error(&DuetError::Cancelled));
    assert!(!is_retryable_error(&DuetError::Io("x".into())));
}

#[test]
fn smoke_task_dto_roundtrip() {
    let dto = TaskDto {
        id: TaskId("test-id".into()),
        kind: TaskKind::Copy,
        status: TaskStatus::Running,
        title: "Copying foo".into(),
        host_key: HostKey::Ssh {
            host_ip: "10.0.0.1".into(),
        },
        progress: Some(ProgressInfo {
            bytes_done: 100,
            bytes_total: Some(200),
            speed_bps: Some(50),
            eta_sec: Some(2),
            percent: Some(50),
        }),
        error_message: None,
        affected_locations: vec![],
    };
    let json = serde_json::to_string(&dto).unwrap();
    let back: TaskDto = serde_json::from_str(&json).unwrap();
    assert_eq!(back.id.0, "test-id");
    assert_eq!(back.kind, TaskKind::Copy);
    assert_eq!(back.title, "Copying foo");
}

#[test]
fn smoke_task_status_completed_roundtrip() {
    let s = TaskStatus::Completed {
        journal_id: JournalId(uuid::Uuid::nil()),
    };
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("completed"));
    assert!(json.contains("journal_id"));
}

#[test]
fn smoke_host_key_serde() {
    let local = HostKey::Local;
    let ssh = HostKey::Ssh {
        host_ip: "1.2.3.4".into(),
    };
    let local_json = serde_json::to_string(&local).unwrap();
    let ssh_json = serde_json::to_string(&ssh).unwrap();
    assert!(local_json.contains("local"));
    assert!(ssh_json.contains("ssh"));
    assert!(ssh_json.contains("1.2.3.4"));
}
```

- [ ] 테스트 + 커밋:

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri && cargo test --test mvp4_smoke
git add src-tauri/tests/mvp4_smoke.rs
git commit -m "test/smoke: MVP-4 — retry matrix + task DTO serde

4 시나리오. 실제 TaskQueue 통합 (worker spawn → enqueue → completion)
은 AppHandle 필요해 후속."
```

---

### Task 12: ROADMAP MVP-4 [x] + final gates

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: 모든 게이트**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --lib
cargo test --tests
cd /Users/ctmctm/Desktop/01_PROJECT/duet
pnpm tsc --noEmit
pnpm lint
pnpm test --run
```

기대: 모두 pass.

- [ ] **Step 2: ROADMAP.md MVP-4 갱신**

Find:
```markdown
## MVP-4: 작업 큐 + 비동기 안정성

**완료 조건**: 큰 작업 중에도 UI 반응. 동시 여러 작업.

- [ ] `TaskQueue` 서비스
- [ ] 진행률 바 컴포넌트 (Toast 위)
- [ ] 작업 목록 패널 (확장)
- [ ] 작업 취소 (`CancellationToken`)
- [ ] 동시 작업 제한 (호스트당 N개)
- [ ] 실패 시 재시도 (네트워크 오류만)
```

→ 신규:
```markdown
## MVP-4: 작업 큐 + 비동기 안정성

**완료 조건**: 큰 작업 중에도 UI 반응. 동시 여러 작업.

- [x] `TaskQueue` 서비스 (per-host_key FIFO worker)
- [x] 진행률 바 컴포넌트 (TasksBar — StatusBar 위)
- [x] 작업 목록 (TasksBar dropdown 2+ active)
- [x] 작업 취소 (`CancellationToken` — 항목 경계 단위)
- [x] 동시 작업 제한 (호스트당 1, N개 사용자 설정은 후속 MVP-7)
- [x] 실패 시 재시도 (연결 끊김만 1회, 3초 sleep)
```

- [ ] **Step 3: 현재 단계 갱신**

```markdown
**MVP-5 시작 직전.** MVP-4 완료 — copy/move 가 background TaskQueue 에서, TasksBar 가 진행률 표시, 항목 단위 cancel + 연결 끊김 1회 retry.
```

- [ ] **Step 4: 커밋**

```bash
cd /Users/ctmctm/Desktop/01_PROJECT/duet
git add ROADMAP.md
git commit -m "docs: MVP-4 완료 표시"
```

---

## 자기 점검

**Spec 커버리지:**

| Spec section | Task |
|---|---|
| services/task_events (TaskId, HostKey, TaskKind, TaskStatus, TaskDto, TaskEvent, TaskChange, ProgressInfo) | 1 |
| services/retry (is_retryable_error) | 2 |
| services/task_queue (TaskQueue + per-host worker + enqueue/cancel/list) | 3 |
| core/ops cancel_token + retry | 4 |
| commands/fs_ops BREAKING + tasks commands + lib.rs events | 5 |
| stores/tasks | 6 |
| useTaskEvents hook | 7 |
| ui-dialogs taskId variant + ProgressModal Background + useProgressEvents 제거 | 8 |
| TasksBar | 9 |
| App integration | 10 |
| Smoke | 11 |
| ROADMAP + final | 12 |

**위험 영역:**
- Task 3 의 `RunFn` Box<dyn FnOnce + Send> 시그니처 — async closure trait 제한 때문에 Box::pin async block 사용 필요. Rust 컴파일러가 까다로울 수 있음.
- Task 5 의 closure 안 plan ownership move — pool/settings/journal/app clone 미리, 안에서 재사용. `move ||` 의 capture 정확도 주의.
- Task 1 에 `affected_locations: Vec<Location>` 필드 추가 명시 — Task 5 (commands) 에서 enqueue 시 plan.items + plan.dst 로 채움. Task 10 (App) 가 이 필드 사용.
- TaskCompleted 시 refresh: 본 plan 에서는 useTaskEvents 가 useTasks store 에서 task 가져와 refresh callback 호출. 종결 후 즉시 remove 하므로 race 가능 — `setStatus` 이전에 callback. (구현 시 순서 careful.)
- ProgressModal close behavior: task 가 store 에서 remove 되면 useTasks.tasks.get(taskId) === undefined → ProgressModal 의 task = undefined. progress = null → spinner. 사용자 입장에서 "끝났는데 spinner" — 자동 close 기대. App.tsx 가 useEffect 로 task 삭제 감지 → closeDialog 호출. 또는 Modal 자체가 task null 일 때 onBackground 자동 호출.
  - **선택: Modal 안에서 useEffect 로 task null 감지 → onBackground 자동 호출.**

**미지원/후속:**
- mid-file cancel (rsync SIGHUP via channel close): MVP-4 v2
- 호스트당 N 동시 (사용자 설정): MVP-7 settings
- task history (완료된 task 보존): 후속
- exponential backoff retry: 후속
- graceful shutdown (앱 종료 시 진행중 task drain): 후속

---

## 실행 핸드오프

Plan complete and saved to `docs/plans/2026-05-10-mvp4-task-queue.md`.

**Phase 단위 권장 분할:**
- Session 1: Phase A (Task 1-3) — task_events + retry + TaskQueue
- Session 2: Phase B + C (Task 4-5) — core/ops cancel + commands BREAKING
- Session 3: Phase D (Task 6-10) — frontend
- Session 4: Phase E (Task 11-12) — smoke + 마무리

**Note**: Phase A 의 Task 1 spec 에 `affected_locations: Vec<Location>` 필드 추가 (App refresh 용). Task 5 (commands) 가 enqueue 시 plan.items + plan.dst 로 채움.
