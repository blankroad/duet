//! 글로벌 검색 IPC.
//!
//! 활성 검색은 한 번에 하나만. 새 검색 시작 시 이전 토큰 cancel.
//! `search_cancel` 도 같은 토큰 cancel.

use std::sync::Arc;

use crate::core::search::{
    LocalFilenameSearch, SearchBackend, SearchHit, SearchOpts, SshFilenameSearch,
};
use crate::services::connection_pool::ConnectionPool;
use crate::types::{DuetError, Location, SourceId};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

/// 활성 검색 토큰 — 새 검색 또는 cancel 시 이전 토큰 cancel.
#[derive(Default)]
pub struct ActiveSearch {
    token: Mutex<Option<CancellationToken>>,
}

impl ActiveSearch {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 이전 토큰 cancel + 새 토큰 발급.
    async fn rotate(&self) -> CancellationToken {
        let mut guard = self.token.lock().await;
        if let Some(prev) = guard.take() {
            prev.cancel();
        }
        let new = CancellationToken::new();
        *guard = Some(new.clone());
        new
    }

    async fn cancel_current(&self) {
        let mut guard = self.token.lock().await;
        if let Some(tok) = guard.take() {
            tok.cancel();
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn search_global(
    root: Location,
    pattern: String,
    opts: SearchOpts,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    active: tauri::State<'_, Arc<ActiveSearch>>,
) -> Result<Vec<SearchHit>, DuetError> {
    if pattern.trim().is_empty() {
        return Ok(vec![]);
    }
    let cancel = active.inner().rotate().await;
    match &root.source {
        SourceId::Local => {
            let backend = LocalFilenameSearch;
            backend.search(&root.path, &pattern, &opts, cancel).await
        }
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.inner().get(connection_id).await?;
            let backend = SshFilenameSearch { conn };
            backend.search(&root.path, &pattern, &opts, cancel).await
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn search_cancel(active: tauri::State<'_, Arc<ActiveSearch>>) -> Result<(), DuetError> {
    active.inner().cancel_current().await;
    Ok(())
}
