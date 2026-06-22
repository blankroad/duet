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
    Extract,
    Compress,
    Sync,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct ProgressInfo {
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub speed_bps: Option<u64>,
    pub eta_sec: Option<u32>,
    /// 0..=100
    pub percent: Option<u8>,
    /// 현재 처리 중인 항목 이름 (탐색기/TC 식 "Copying <name>" 표시용). 없으면 None.
    pub current_file: Option<String>,
    /// 완료한 항목 수 / 전체 항목 수 (top-level plan.items 기준). 0 = 미집계.
    pub files_done: u32,
    pub files_total: u32,
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
