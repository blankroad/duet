# MVP-4 Design: 작업 큐 + 비동기 안정성

**Status:** Approved (브레인스토밍 합의 완료, plan 작성 단계)
**Date:** 2026-05-10
**Scope:** ROADMAP MVP-4 6 항목

## Goal

큰 copy/move 작업이 background 로 진행되어 UI 가 반응성을 유지. 호스트당 동시 작업 수 제어, 사용자 취소, 연결 끊김 자동 재시도.

## 완료 조건

- 사용자가 copy/move confirm → IPC 가 즉시 `TaskId` 반환 (현재는 끝까지 await)
- TasksBar (StatusBar 위 새 영역) 가 진행 중 task 표시: 1개면 mini progress, 2+면 expandable dropdown, 0개면 hidden
- ProgressModal 에 "Background" 버튼 — 닫아도 op 는 TaskQueue 에서 계속, TasksBar 가 인계
- task cancel 가능 — 항목 경계 단위 (한 파일은 끝까지, 다음부터 skip)
- 같은 호스트 (host_ip) 의 task 들은 FIFO 1개 동시. 다른 호스트는 병렬
- 연결 끊김 (`ConnectionFailed` 또는 Ssh "channel closed"/"EOF"/"broken pipe") 1회 자동 retry, 3초 sleep 후
- backend `task_queue` / `retry` 단위 테스트 통과
- frontend `tasks` store + `useTaskEvents` 통합

## Key decisions (brainstorming)

| # | 질문 | 결정 |
|---|---|---|
| 1 | TaskQueue scope | **copy/move 만** enqueue. delete/rename/mkdir 는 기존 동기 await (보통 < 200ms). |
| 2 | Cancellation 그래뉼래리티 | **항목 경계 단위** — 현재 파일은 끝까지, 다음부터 skip. mid-file kill 은 후속. |
| 3 | Retry 정책 | **연결 끊김만 1회 retry, 3초 후**. exponential backoff 없음. AuthFailed/NotFound 등 즉시 fail. |
| 4 | Concurrency limit | **호스트당 1 worker FIFO**. host_key = `Local | Ssh(IpAddr)`. 사용자 N 개 설정은 후속. |

---

## Architecture overview

### 새 백엔드 모듈

- `services/task_events.rs` — typed `TaskEvent` + `TaskChange` enum + `TaskDto` + `TaskStatus` + `TaskKind` + `HostKey` + `TaskId` 타입.
- `services/task_queue.rs` — `TaskQueue` struct (Tauri State). per-host_key worker (tokio::spawn + mpsc::Receiver loop) FIFO 처리. enqueue/cancel/list API.
- `services/retry.rs` — `is_retryable_error(&DuetError) -> bool` 헬퍼 + 단위 테스트.

### 기존 모듈 변경

- `core/ops.rs::copy_execute` / `move_execute` — `cancel_token: CancellationToken` 인자 추가. 항목 loop 진입 시 `if cancel_token.is_cancelled() { return Err(DuetError::Cancelled) }`.
- `commands/fs_ops.rs::fs_copy_execute` / `fs_move_execute` — **BREAKING**: TaskQueue 에 enqueue → 즉시 `TaskId` 반환. 기존 `JournalId` 반환은 `TaskEvent::Completed { journal_id }` 로 이동.
- `services/progress_events.rs` — **제거**. `TaskEvent::Progress` 로 통합.
- `lib.rs::make_specta_builder` — collect_events 에서 `ProgressEvent` 제거, `TaskEvent` 추가.

### Frontend 변경

- `hooks/useProgressEvents.ts` — **제거**.
- `hooks/useTaskEvents.ts` — 신규. bootstrap (tasks_list) + listen (TaskEvent).
- `stores/tasks.ts` — 신규. Map<TaskId, Task> 기반.
- `stores/ui-dialogs.ts::ProgressInfo` — `tasks` store 의 task.progress 와 일치 (재사용).
- `components/TasksBar.tsx` — 신규. StatusBar 위 새 영역. 1개 active 면 mini progress + Cancel, 2+ 면 `[N tasks ▼]` expandable, 0개면 hidden.
- `components/dialogs/ProgressModal.tsx` — "Background" 버튼 추가. 닫아도 task 계속 (TasksBar 가 표시).
- `App.tsx` — onCopy/MoveConfirm 흐름 변경: execute 즉시 dialog close, refresh 는 `TaskEvent::Completed` 받아서.

---

## Concurrency model

```
TaskQueue {
    workers: HashMap<HostKey, mpsc::Sender<EnqueuedTask>>,
    tasks: HashMap<TaskId, TaskState>,  // snapshot for tasks_list
}

per host_key:
  worker = tokio::spawn(async {
      while let Some(enqueued) = rx.recv().await {
          // mark Running, emit Started
          run(enqueued).await;
          // mark Completed/Cancelled/Failed, emit
      }
  });
```

- `HostKey` enum: `Local`, `Ssh(IpAddr)`. derived `Hash + Eq`.
- 같은 host_key 의 새 enqueue → 기존 sender 재사용. 새 host_key 면 worker spawn + sender 보관.
- worker 가 task 처리 중에도 다른 host_key worker 는 독립 실행 (병렬).
- Worker shutdown: 앱 종료 시 senders drop → worker loop 자연 종료. 진행 중 task 는 abort (rsync 는 SSH 끊김으로 자연 종료, local copy 는 tokio runtime 종료).

---

## Cancellation

- 각 Task 가 own `tokio_util::sync::CancellationToken`.
- `task_cancel(task_id)` command → token.cancel().
- Queued 상태 (worker 도달 전) 에서 cancel: worker loop 가 receive 후 첫 line `if cancel_token.is_cancelled() { mark Cancelled, emit, continue; }`.
- Running 상태에서 cancel: `core/ops.rs` 의 항목 loop 시작에서 check → `Err(DuetError::Cancelled)` 반환. partial state (이미 복사된 파일) 는 dst 에 남음.
- mid-file cancel (rsync kill) 은 v2 후속. 현재는 항목 경계.

---

## Retry policy

- 1회만 retry, 3초 sleep 후 같은 plan 재실행.
- Trigger: `is_retryable_error(&DuetError) -> bool`:
  - `ConnectionFailed(_)` → true
  - `Ssh(msg)` 가 substring "channel closed" / "EOF" / "broken pipe" 포함 → true
  - 그 외 → false
- Backup rename idempotency: retry 시 dst 에 `.bak.<ts>` 가 이미 있으면 skip rename. backup 위치 정확.
- Cancel 도중 retry 트리거 안 됨 (cancel_token check 우선).

---

## IPC + 이벤트 surface

### Commands

```rust
// BREAKING: 시그니처 변경
fs_copy_execute(plan: CopyPlan, ...) -> Result<TaskId, DuetError>
fs_move_execute(plan: MovePlan, ...) -> Result<TaskId, DuetError>

// 신규
tasks_list() -> Vec<TaskDto>
task_cancel(task_id: TaskId) -> ()
```

### DTOs

```rust
#[derive(Serialize, Deserialize, Type)]
pub struct TaskId(pub String);  // uuid v7

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostKey {
    Local,
    Ssh { host_ip: String },
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Copy,
    Move,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Running,
    Completed { journal_id: JournalId },
    Cancelled,
    Failed { message: String },
}

#[derive(Serialize, Deserialize, Type)]
pub struct TaskDto {
    pub id: TaskId,
    pub kind: TaskKind,
    pub status: TaskStatus,
    pub title: String,           // "Copying foo.zip → /tmp"
    pub host_key: HostKey,
    pub progress: Option<ProgressInfo>,  // ProgressInfo 는 frontend 와 동일 모양
    pub error_message: Option<String>,
}
```

### Events

```rust
#[derive(Serialize, Deserialize, Type, Event)]
pub struct TaskEvent {
    pub task_id: TaskId,
    pub change: TaskChange,
}

#[derive(Serialize, Deserialize, Type)]
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

### Frontend 흐름 변화

```
Before:
  User confirm → fsCopyExecute (await N seconds) → onSuccess refresh

After:
  User confirm → fsCopyExecute (returns TaskId in <100ms)
              → ProgressModal (선택): 보이는 동안 진행률, "Background" 누르면 close
              → TasksBar 에 task 표시 (modal 닫혀도 계속)
              → TaskEvent::Progress 로 % update
              → TaskEvent::Completed → refreshAffected 자동 호출
```

---

## Frontend tasks store

```typescript
import { create } from "zustand";
import type { TaskDto, JournalId } from "@/types/bindings";

export interface TasksState {
  tasks: Map<string, TaskDto>;
  add: (t: TaskDto) => void;
  update: (id: string, patch: Partial<TaskDto>) => void;
  setProgress: (id: string, progress: ProgressInfo) => void;
  setStatus: (id: string, status: TaskDto["status"]) => void;
  remove: (id: string) => void;
  clear: () => void;
}
```

UI 헬퍼 selector:
- `useActiveTasks()` — status === "queued" | "running" 만 (TasksBar 가 표시할 것)
- `useTaskById(id)` — ProgressModal 이 사용 (modal 의 dialog.taskId 와 매칭)

---

## TasksBar UI

DESIGN.md mockup:
```
│ ⠋ Copying foo.zip → /tmp/  ████░░░  40%   [3 tasks]      │
```

구현:
- active 0개: 컴포넌트 자체 hidden (height 0)
- active 1개: `<spinner> {title}  <bar 40%>  {bytes/total}  [Cancel]`
- active 2+: `<spinner> {first.title}  ...  [N tasks ▼]` — 클릭 시 dropdown 으로 모든 active task list (각각 cancel)

---

## ProgressModal Background 버튼

기존 (MVP-2): ESC/outside 차단 → 사용자 강제 대기.
신규: "Background" 버튼 — 누르면 modal close, task 는 TaskQueue 에서 계속. TasksBar 가 인계.

modal 의 progress 데이터: `useTaskById(dialog.taskId)` 로 가져와 표시 — 별도 setProgress 안 함. dialog.kind === "progress" 면 dialog.taskId 를 보유.

`ui-dialogs.ts` DialogState 변경:
```ts
| { kind: "progress"; title: string; taskId: string }  // taskId 추가, progress 필드 제거
```

ProgressModal 내부에서 `useTaskById(taskId)` → task.progress 사용.

---

## Test strategy

### Backend

- `services/task_queue.rs`:
  - enqueue 후 list 에 보임
  - 같은 host_key FIFO (두 task 순차)
  - 다른 host_key 병렬
  - cancel queued: 즉시 Cancelled
  - cancel running: token signal → Cancelled (fake op)
  - completed: status update + journal_id
  - failed: error_message 저장
- `services/retry.rs::is_retryable_error`: 5-6 case
- `core/ops.rs` 의 cancel 통합: cancel_token 인자 받음 + check
- 기존 op 테스트 갱신 (cancel_token 인자 추가 — `CancellationToken::new()` 기본)

### Smoke

`tests/mvp4_smoke.rs`:
- enqueue copy → poll 으로 list 확인 → completion 대기 → journal entry 존재
- cancel queued → status Cancelled, fs op 안 일어남
- two same-host tasks → FIFO 순서
- is_retryable_error matrix

### Frontend

- `stores/tasks.test.ts` — add/update/remove/Map 동작
- `useTaskEvents` mock — TaskChange 5종 처리

---

## 위험 영역

- **Race**: enqueue 직후 cancel — task 가 worker 도달 전. cancel_token check 로 처리.
- **Worker shutdown**: 앱 종료 시 진행중 task abort. graceful drain 은 후속.
- **Bootstrap 동기화**: tasks_list snapshot vs 이후 events. 순서: useEffect 에서 listen 시작 → list 호출 → store init → event 적용 (event 가 list 결과 적용 직후 도착해도 update). race 가능하지만 event idempotent.
- **fs_copy_execute / fs_move_execute breaking change**: App.tsx 의 onCopy/MoveConfirm 흐름 리팩토링 필요. 다른 callers 없음 (확인).
- **session_mutex 와 worker 호스트 직렬화**: per-host worker FIFO 라 동일 connection 의 동시 op 불가 → MVP-3 의 session lock scope 이슈 자동 회피.
- **mid-file cancel 안 됨**: 큰 파일 1개 복사 중 cancel 누르면 그 파일 끝까지. 사용자 expectation 차이 — UI 에 "current file finishing" 표시 또는 후속 mid-file kill.

---

## Phase 분할

- **Phase A — Foundation**
  - `services/task_events.rs` (TaskEvent + TaskChange + TaskDto + 모든 enum)
  - `services/task_queue.rs` (struct + enqueue/cancel/list + per-host worker — fake op으로 테스트)
  - `services/retry.rs` (is_retryable_error)
- **Phase B — core/ops cancellation 통합**
  - `core/ops.rs::copy_execute` / `move_execute` 시그니처 + cancel check
  - retry helper 통합 (single retry on connection loss)
  - 기존 테스트 인자 갱신
- **Phase C — IPC commands**
  - `fs_copy_execute` / `fs_move_execute` BREAKING → enqueue → TaskId
  - `tasks_list` / `task_cancel` 신규
  - lib.rs collect_events: TaskEvent 추가, ProgressEvent 제거
  - bindings 자동 갱신
- **Phase D — Frontend**
  - `stores/tasks.ts` 신규 + tests
  - `hooks/useTaskEvents.ts` (bootstrap + listen)
  - `useProgressEvents.ts` 제거
  - `components/TasksBar.tsx` 신규
  - `ProgressModal` "Background" 버튼 + dialog.taskId 기반 useTaskById
  - `ui-dialogs.ts` DialogState progress variant 변경 (taskId 보유)
  - `App.tsx` 리팩토링: onCopy/MoveConfirm + StatusBar 위 TasksBar 배치
- **Phase E — Smoke + 마무리**
  - `tests/mvp4_smoke.rs`
  - ROADMAP MVP-4 [x]
  - 최종 quality gates

---

## Open items / deferred

- mid-file cancel (rsync SIGHUP via channel close + chunked relay): MVP-4 v2
- 호스트당 N개 동시 (사용자 설정): MVP-7 (settings UI)
- graceful shutdown (앱 종료 시 진행 중 task drain): 후속
- task list panel "확장" (ROADMAP "확장" 표현) — 현재 dropdown 으로 단순. full panel 은 후속.
- task history (완료된 task 의 last N): 현재 완료 직후 store 에서 remove. 보존 후속.

---

## CLAUDE.md 규약 준수 체크

- §1 IPC 경계: TaskQueue 는 backend, frontend 는 commands 로만 접근. ✅
- §2 백엔드 레이어: services/task_queue 는 services 레이어, core/ops 호출. 단방향. ✅
- §3 영구삭제: 무관 (copy/move 만).
- §4 undo: TaskEvent::Completed 시 journal entry 가 push 됨 — Ctrl+Z 로 undo 가능 (기존 흐름). ✅
- §5 자격증명: 무관.
- §6 의존성: `tokio_util::sync::CancellationToken` 은 tokio_util 안에 있고 이미 deps. 새 crate 없음. ✅
- §7 path: 무관.
- §8 unsafe: 없음.
- §9 시스템 ssh: 무관 (기존 remote_exec 재사용).
- DON'T list silent relay: 기존 정책 유지 — TaskQueue 도 SshSameHost plan 만 same_host_copy 호출. ✅

---

## Spec self-review

- [x] Placeholder scan: TBD/TODO 없음
- [x] Internal consistency: Phase A-E 가 design 의 모든 모듈/컴포넌트와 1:1
- [x] Scope check: 단일 plan 처리 가능. UI/backend 양쪽 변화 크지만 결합도 명확
- [x] Ambiguity check: cancel granularity (항목 경계), retry trigger (3개 substring + ConnectionFailed), concurrency limit (호스트당 1) 모두 명시
