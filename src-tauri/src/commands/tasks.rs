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
