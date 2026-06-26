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

use crate::services::fs_events::FsChangedEvent;
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
            Box<
                dyn std::future::Future<Output = Result<JournalId, crate::types::DuetError>> + Send,
            >,
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
        // 완료 시 영향받은 디렉토리에 fs:changed 를 쏘기 위해 affected 를 미리 확보.
        let affected = inner
            .tasks
            .get_mut(task_id)
            .map(|record| {
                record.dto.status = status.clone();
                record.dto.affected_locations.clone()
            })
            .unwrap_or_default();
        let change = match &status {
            TaskStatus::Completed { journal_id } => TaskChange::Completed {
                journal_id: *journal_id,
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
        // 영향받은 디렉토리로 fs:changed emit — OS watcher 와 무관하게 패널 자동 새로고침.
        // Completed 뿐 아니라 Cancelled/Failed 에서도 emit — §4 부분 진행분(반쯤 옮겨진
        // 폴더 등)이 있을 수 있어 패널이 stale 하지 않게. (여기는 종결 상태에서만 도달.)
        for loc in &affected {
            let _ = FsChangedEvent {
                source: loc.source.clone(),
                path: loc.path.to_string_lossy().into_owned(),
            }
            .emit(&self.app);
        }
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
