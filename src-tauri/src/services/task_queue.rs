//! 비동기 작업 큐 (per-host_key FIFO worker).
//!
//! `TaskQueue` 는 Tauri State 로 등록. `enqueue_*` 호출 시:
//! 1. TaskRecord 만들어 inner state 에 보관 (status = Queued)
//! 2. host_key 의 worker 에게 mpsc 로 WorkItem 보냄 (worker 없으면 spawn)
//! 3. `TaskEvent::Enqueued` emit
//!
//! Worker 는 `WorkItem` 받아:
//! - 대기 중에 취소됐으면 silent skip (cancel() 이 이미 종결 이벤트를 냈다)
//! - 아니면 status → Running, `Started` emit, run 호출 (취소 확인과 Running 전환은 한 잠금 안)
//! - run 결과: Completed { journal_id } / Cancelled / Failed { message }
//! - 종결 이벤트는 작업마다 **정확히 한 번** — emit 후 state 에서 record 제거
//!
//! `cancel(task_id)`:
//! - 대기 중이면 token.cancel() + status → Cancelled + emit (즉시 종결, 실행 안 함).
//! - 실행 중이면 token.cancel() 만 — 종결 이벤트는 작업이 실제로 멈춘 뒤 worker 가 낸다
//!   (마지막 확인 지점을 이미 지났으면 Completed/Failed 로 끝날 수 있다, fileops-16).
//!   그때까지 작업은 목록에 남고 같은 host 의 다음 작업은 시작하지 않는다.

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

/// 큐가 내보내는 이벤트를 받는 곳 — 앱에선 Tauri 이벤트, 단위 테스트에선 기록.
pub(crate) trait TaskSink: Send + Sync {
    fn task(&self, event: TaskEvent);
    fn fs_changed(&self, event: FsChangedEvent);
}

/// 앱의 실제 이벤트 — Tauri 로 frontend 에 보낸다.
struct AppSink(AppHandle);

impl TaskSink for AppSink {
    fn task(&self, event: TaskEvent) {
        let _ = event.emit(&self.0);
    }
    fn fs_changed(&self, event: FsChangedEvent) {
        let _ = event.emit(&self.0);
    }
}

/// Worker 의 progress emit 채널 — closure 가 호출.
#[derive(Clone)]
pub struct ProgressEmitter {
    sink: Arc<dyn TaskSink>,
    task_id: TaskId,
}

impl ProgressEmitter {
    pub fn emit(&self, p: ProgressInfo) {
        self.sink.task(TaskEvent {
            task_id: self.task_id.clone(),
            change: TaskChange::Progress { progress: p },
        });
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
    sink: Arc<dyn TaskSink>,
}

/// 종결 상태인가 — 종결 이벤트를 이미 냈다는 뜻.
fn is_terminal(status: &TaskStatus) -> bool {
    matches!(
        status,
        TaskStatus::Completed { .. } | TaskStatus::Cancelled | TaskStatus::Failed { .. }
    )
}

impl TaskQueue {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Self::with_sink(Arc::new(AppSink(app)))
    }

    /// 이벤트 받는 곳을 지정해 만든다 — 단위 테스트가 이벤트 순서·횟수를 본다.
    pub(crate) fn with_sink(sink: Arc<dyn TaskSink>) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Inner {
                workers: HashMap::new(),
                tasks: HashMap::new(),
            }),
            sink,
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

        self.sink.task(TaskEvent {
            task_id: task_id.clone(),
            change: TaskChange::Enqueued { task: dto },
        });

        let _ = sender.send(WorkItem {
            task_id: task_id.clone(),
            cancel_token,
            run,
        });

        task_id
    }

    /// cancel — 대기 중이면 즉시 종결(Cancelled emit), 실행 중이면 token 만 취소한다.
    ///
    /// 실행 중인 작업의 종결 이벤트는 worker 가 run 이 돌아온 뒤 한 번만 낸다 — 여기서
    /// 미리 "취소됨"을 내면 작업이 계속 돌다 또 종결 이벤트를 내거나(이중 토스트) 사실은
    /// 끝까지 완료됐는데 "취소됨"으로 보였다(fileops-16). 여러 번 불러도 같다(idempotent).
    /// 이미 종결된 task 는 no-op.
    pub async fn cancel(self: &Arc<Self>, task_id: &TaskId) {
        let mut inner = self.state.lock().await;
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return;
        };
        match record.dto.status {
            TaskStatus::Queued => {
                record.cancel_token.cancel();
                record.dto.status = TaskStatus::Cancelled;
                self.sink.task(TaskEvent {
                    task_id: task_id.clone(),
                    change: TaskChange::Cancelled,
                });
                // record 는 worker 가 그 항목을 꺼낼 때 제거한다(silent skip).
            }
            TaskStatus::Running => record.cancel_token.cancel(),
            _ => {} // 이미 종결
        }
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

    /// 내부용 — worker 가 호출. status update + 종결 이벤트(작업마다 한 번) + record 제거.
    /// `error` 는 Failed 일 때의 구조화된 원인 — frontend 가 kind 로 분기 (NeedPassword 등).
    async fn finalize(
        &self,
        task_id: &TaskId,
        status: TaskStatus,
        error: Option<crate::types::DuetError>,
    ) {
        let change = match &status {
            TaskStatus::Completed { journal_id } => TaskChange::Completed {
                journal_id: *journal_id,
            },
            TaskStatus::Cancelled => TaskChange::Cancelled,
            TaskStatus::Failed { message } => TaskChange::Failed {
                message: message.clone(),
                // finalize 를 Failed 로 부르는 곳은 worker 뿐이라 error 는 항상 Some —
                // 방어적으로 없으면 message 를 Io 로 감싼다.
                error: error.unwrap_or_else(|| crate::types::DuetError::Io(message.clone())),
            },
            _ => return, // Queued / Running 은 finalize 아님
        };
        let mut inner = self.state.lock().await;
        // 이미 종결 이벤트를 낸 작업(없거나 종결 상태)이면 다시 내지 않는다.
        let Some(record) = inner.tasks.get_mut(task_id) else {
            return;
        };
        if is_terminal(&record.dto.status) {
            inner.tasks.remove(task_id);
            return;
        }
        record.dto.status = status;
        // 완료 시 영향받은 디렉토리에 fs:changed 를 쏘기 위해 affected 를 미리 확보.
        let affected = record.dto.affected_locations.clone();
        self.sink.task(TaskEvent {
            task_id: task_id.clone(),
            change,
        });
        // 영향받은 디렉토리로 fs:changed emit — OS watcher 와 무관하게 패널 자동 새로고침.
        // Completed 뿐 아니라 Cancelled/Failed 에서도 emit — §4 부분 진행분(반쯤 옮겨진
        // 폴더 등)이 있을 수 있어 패널이 stale 하지 않게. (여기는 종결 상태에서만 도달.)
        for loc in &affected {
            self.sink.fs_changed(FsChangedEvent {
                source: loc.source.clone(),
                path: loc.path.to_string_lossy().into_owned(),
            });
        }
        // 종결 후 제거 — frontend 는 이미 event 받음
        inner.tasks.remove(task_id);
    }

    /// 꺼낸 작업을 시작해도 되면 Running 으로 바꾸고 true. 대기 중에 취소됐으면 record 를
    /// 지우고 false — 취소 확인과 Running 전환이 한 잠금 안이라 그 사이 cancel 이 끼어
    /// 종결 이벤트가 두 번 나가는 일이 없다.
    async fn try_start(&self, task_id: &TaskId, token: &CancellationToken) -> bool {
        let mut inner = self.state.lock().await;
        let startable = !token.is_cancelled()
            && inner
                .tasks
                .get(task_id)
                .is_some_and(|r| matches!(r.dto.status, TaskStatus::Queued));
        if !startable {
            inner.tasks.remove(task_id);
            return false;
        }
        if let Some(record) = inner.tasks.get_mut(task_id) {
            record.dto.status = TaskStatus::Running;
        }
        self.sink.task(TaskEvent {
            task_id: task_id.clone(),
            change: TaskChange::Started,
        });
        true
    }
}

fn spawn_worker(queue: Arc<TaskQueue>) -> mpsc::UnboundedSender<WorkItem> {
    let (tx, mut rx) = mpsc::unbounded_channel::<WorkItem>();
    tokio::spawn(async move {
        while let Some(item) = rx.recv().await {
            let task_id = item.task_id.clone();
            // 대기 중에 취소됨: silent skip (cancel() 이 이미 종결 이벤트를 냈다).
            if !queue.try_start(&task_id, &item.cancel_token).await {
                continue;
            }
            let emitter = ProgressEmitter {
                sink: queue.sink.clone(),
                task_id: task_id.clone(),
            };
            let result = (item.run)(item.cancel_token.clone(), emitter).await;
            let (status, error) = match result {
                Ok(journal_id) => (TaskStatus::Completed { journal_id }, None),
                Err(crate::types::DuetError::Cancelled) => (TaskStatus::Cancelled, None),
                Err(e) => (
                    TaskStatus::Failed {
                        message: format!("{e}"),
                    },
                    Some(e),
                ),
            };
            queue.finalize(&task_id, status, error).await;
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DuetError;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::oneshot;

    /// 이벤트를 `"<task 이름>:<종류>"` 로 순서대로 기록한다.
    #[derive(Default)]
    struct Recorder {
        names: std::sync::Mutex<HashMap<TaskId, &'static str>>,
        log: std::sync::Mutex<Vec<String>>,
    }

    impl Recorder {
        fn name(&self, id: &TaskId, name: &'static str) {
            self.names.lock().unwrap().insert(id.clone(), name);
        }
        fn log(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
        /// 이 작업의 종결 이벤트들.
        fn terminals(&self, name: &str) -> Vec<String> {
            self.log()
                .into_iter()
                .filter(|e| {
                    e.starts_with(&format!("{name}:"))
                        && (e.ends_with(":completed")
                            || e.ends_with(":cancelled")
                            || e.ends_with(":failed"))
                })
                .collect()
        }
    }

    impl TaskSink for Recorder {
        fn task(&self, event: TaskEvent) {
            let kind = match event.change {
                TaskChange::Enqueued { .. } => "enqueued",
                TaskChange::Started => "started",
                TaskChange::Progress { .. } => return,
                TaskChange::Completed { .. } => "completed",
                TaskChange::Cancelled => "cancelled",
                TaskChange::Failed { .. } => "failed",
            };
            // enqueue 가 TaskId 를 돌려주기 전에 Enqueued 가 오므로 이름이 없을 수 있다.
            let name = self
                .names
                .lock()
                .unwrap()
                .get(&event.task_id)
                .copied()
                .unwrap_or("?");
            self.log.lock().unwrap().push(format!("{name}:{kind}"));
        }
        fn fs_changed(&self, _event: FsChangedEvent) {}
    }

    fn setup() -> (Arc<Recorder>, Arc<TaskQueue>) {
        let rec = Arc::new(Recorder::default());
        let q = TaskQueue::with_sink(rec.clone());
        (rec, q)
    }

    /// 시작되면 `started` 로 알리고, `release` 가 오면 `result` 를 돌려주는 작업.
    /// `stop_on_cancel` 이면 취소 신호를 본 뒤에야 release 를 기다린다(확인 지점에서 멈춤).
    fn gated(
        started: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
        result: Result<(), DuetError>,
        stop_on_cancel: bool,
    ) -> RunFn {
        Box::new(move |token, _progress| {
            Box::pin(async move {
                let _ = started.send(());
                if stop_on_cancel {
                    token.cancelled().await;
                }
                let _ = release.await;
                match result {
                    Ok(()) if stop_on_cancel => Err(DuetError::Cancelled),
                    Ok(()) => Ok(JournalId::new()),
                    Err(e) => Err(e),
                }
            })
        })
    }

    async fn enqueue(
        q: &Arc<TaskQueue>,
        rec: &Recorder,
        name: &'static str,
        host: HostKey,
        run: RunFn,
    ) -> TaskId {
        let id = q
            .enqueue(TaskKind::Copy, name.into(), host, vec![], run)
            .await;
        rec.name(&id, name);
        id
    }

    /// 다른 작업들이 한 걸음씩 진행하도록 양보한다.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    async fn wait_gone(q: &TaskQueue, id: &TaskId) {
        for _ in 0..400 {
            if !q.list().await.iter().any(|t| &t.id == id) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        panic!("task {id:?} never finished");
    }

    #[tokio::test]
    async fn running_cancel_waits_for_the_task_then_emits_one_cancelled() {
        let (rec, q) = setup();
        let (s_tx, s_rx) = oneshot::channel();
        let (r_tx, r_rx) = oneshot::channel();
        let a = enqueue(
            &q,
            &rec,
            "a",
            HostKey::Local,
            gated(s_tx, r_rx, Ok(()), true),
        )
        .await;
        s_rx.await.unwrap();
        q.cancel(&a).await;
        q.cancel(&a).await; // 두 번 눌러도 같다
        settle().await;
        // 작업이 아직 멈추지 않았다 — 종결 이벤트 없음, 목록에 남아 있음.
        assert!(rec.terminals("a").is_empty(), "{:?}", rec.log());
        assert!(q.list().await.iter().any(|t| t.id == a));
        r_tx.send(()).unwrap();
        wait_gone(&q, &a).await;
        q.cancel(&a).await; // 끝난 뒤의 취소는 no-op
        assert_eq!(rec.terminals("a"), vec!["a:cancelled"]);
    }

    #[tokio::test]
    async fn cancel_after_the_last_checkpoint_reports_completed_only() {
        let (rec, q) = setup();
        let (s_tx, s_rx) = oneshot::channel();
        let (r_tx, r_rx) = oneshot::channel();
        // 취소 신호를 보지 않고 끝까지 가는 작업(마지막 확인 지점을 이미 지남).
        let a = enqueue(
            &q,
            &rec,
            "a",
            HostKey::Local,
            gated(s_tx, r_rx, Ok(()), false),
        )
        .await;
        s_rx.await.unwrap();
        q.cancel(&a).await;
        r_tx.send(()).unwrap();
        wait_gone(&q, &a).await;
        assert_eq!(rec.terminals("a"), vec!["a:completed"], "{:?}", rec.log());
    }

    #[tokio::test]
    async fn running_cancel_that_fails_reports_failed_only() {
        let (rec, q) = setup();
        let (s_tx, s_rx) = oneshot::channel();
        let (r_tx, r_rx) = oneshot::channel();
        let a = enqueue(
            &q,
            &rec,
            "a",
            HostKey::Local,
            gated(s_tx, r_rx, Err(DuetError::Io("disk".into())), false),
        )
        .await;
        s_rx.await.unwrap();
        q.cancel(&a).await;
        r_tx.send(()).unwrap();
        wait_gone(&q, &a).await;
        assert_eq!(rec.terminals("a"), vec!["a:failed"]);
    }

    #[tokio::test]
    async fn queued_cancel_terminates_once_and_never_runs() {
        let (rec, q) = setup();
        let (s_tx, s_rx) = oneshot::channel();
        let (r_tx, r_rx) = oneshot::channel();
        let a = enqueue(
            &q,
            &rec,
            "a",
            HostKey::Local,
            gated(s_tx, r_rx, Ok(()), false),
        )
        .await;
        s_rx.await.unwrap();
        let ran = Arc::new(AtomicBool::new(false));
        let ran_b = ran.clone();
        let b = enqueue(
            &q,
            &rec,
            "b",
            HostKey::Local,
            Box::new(move |_t, _p| {
                Box::pin(async move {
                    ran_b.store(true, Ordering::SeqCst);
                    Ok(JournalId::new())
                })
            }),
        )
        .await;
        q.cancel(&b).await;
        // 대기 중 취소는 즉시 종결된다.
        assert_eq!(rec.terminals("b"), vec!["b:cancelled"]);
        q.cancel(&b).await;
        r_tx.send(()).unwrap();
        wait_gone(&q, &a).await;
        wait_gone(&q, &b).await;
        assert!(!ran.load(Ordering::SeqCst), "cancelled queued task ran");
        assert_eq!(rec.terminals("b"), vec!["b:cancelled"], "{:?}", rec.log());
        assert!(!rec.log().contains(&"b:started".to_string()));
    }

    #[tokio::test]
    async fn same_host_fifo_waits_for_a_cancelling_task_other_hosts_continue() {
        let (rec, q) = setup();
        let (sa_tx, sa_rx) = oneshot::channel();
        let (ra_tx, ra_rx) = oneshot::channel();
        let a = enqueue(
            &q,
            &rec,
            "a",
            HostKey::Local,
            gated(sa_tx, ra_rx, Ok(()), true),
        )
        .await;
        sa_rx.await.unwrap();
        let (sb_tx, _sb_rx) = oneshot::channel();
        let (rb_tx, rb_rx) = oneshot::channel();
        let b = enqueue(
            &q,
            &rec,
            "b",
            HostKey::Local,
            gated(sb_tx, rb_rx, Ok(()), false),
        )
        .await;
        let (sc_tx, sc_rx) = oneshot::channel();
        let (rc_tx, rc_rx) = oneshot::channel();
        let other = HostKey::Ssh {
            host_ip: "10.0.0.5".into(),
        };
        let c = enqueue(&q, &rec, "c", other, gated(sc_tx, rc_rx, Ok(()), false)).await;
        q.cancel(&a).await;
        // 다른 host 의 작업은 그대로 돈다.
        sc_rx.await.unwrap();
        rc_tx.send(()).unwrap();
        wait_gone(&q, &c).await;
        assert_eq!(rec.terminals("c"), vec!["c:completed"]);
        settle().await;
        // 같은 host 의 b 는 a 가 실제로 멈출 때까지 시작하지 않는다.
        assert!(
            !rec.log().contains(&"b:started".to_string()),
            "{:?}",
            rec.log()
        );
        assert!(rec.terminals("b").is_empty());
        ra_tx.send(()).unwrap();
        wait_gone(&q, &a).await;
        rb_tx.send(()).unwrap();
        wait_gone(&q, &b).await;
        let log = rec.log();
        let pos = |e: &str| log.iter().position(|x| x == e).unwrap();
        assert!(pos("a:cancelled") < pos("b:started"), "{log:?}");
        assert_eq!(rec.terminals("a"), vec!["a:cancelled"]);
        assert_eq!(rec.terminals("b"), vec!["b:completed"]);
    }
}
