//! 글로벌 검색 IPC.
//!
//! 활성 검색은 한 번에 하나만. 새 검색 시작 시 이전 토큰 cancel.
//! `search_cancel` 도 같은 토큰 cancel.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::core::search::{
    LocalContentSearch, LocalFilenameSearch, SearchBackend, SearchHit, SearchOpts,
    SshContentSearch, SshFilenameSearch,
};
use crate::services::connection_pool::{ActiveConnection, ConnectionPool};
use crate::services::file_index::{index_key, FileIndex, IndexedPath};
use crate::types::{DuetError, EntryKind, Location, SourceId};
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
            // opts.content 에 따라 내용(grep) / 파일명 backend 선택.
            if opts.content {
                LocalContentSearch
                    .search(&root.path, &pattern, &opts, cancel)
                    .await
            } else {
                LocalFilenameSearch
                    .search(&root.path, &pattern, &opts, cancel)
                    .await
            }
        }
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.inner().get(connection_id).await?;
            if opts.content {
                SshContentSearch { conn }
                    .search(&root.path, &pattern, &opts, cancel)
                    .await
            } else {
                SshFilenameSearch { conn }
                    .search(&root.path, &pattern, &opts, cancel)
                    .await
            }
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn search_cancel(active: tauri::State<'_, Arc<ActiveSearch>>) -> Result<(), DuetError> {
    active.inner().cancel_current().await;
    Ok(())
}

// ===== 파일명 인덱스(Everything 식 즉시·오프라인) 검색 =====

/// 원격 호스트 트리를 `find` 1회로 인덱스용 경로 목록 수집. (kind 는 파일명 인덱스라
/// File 로 근사 — parse_find_output 과 동일. 표시 아이콘만 영향, 검색/네비는 무관.)
async fn build_remote_index(
    conn: &Arc<ActiveConnection>,
    root: &Path,
) -> Result<Vec<IndexedPath>, DuetError> {
    use crate::core::copy_strategy::shell_escape_path;
    use crate::ssh::remote_exec::exec;
    let root_arg = shell_escape_path(root)?;
    let cmd = format!("find {root_arg} \\( -type f -o -type d -o -type l \\) 2>/dev/null");
    let session_mutex = conn
        .session
        .as_ref()
        .ok_or_else(|| DuetError::ConnectionFailed("no live session".into()))?;
    let out = {
        let handle = session_mutex.lock().await;
        exec(&handle, &cmd).await?
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    Ok(stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| IndexedPath {
            path: PathBuf::from(l),
            kind: EntryKind::File,
            size: 0,
            modified_ms: None,
        })
        .collect())
}

/// root 의 인덱스를 (재)빌드. 로컬=ignore 워크, 원격=find(연결 필요).
async fn build_index_for(
    root: &Location,
    pool: &Arc<ConnectionPool>,
    index: &Arc<FileIndex>,
) -> Result<(), DuetError> {
    match &root.source {
        SourceId::Local => {
            index.build_local(&root.path).await?;
        }
        SourceId::Ssh { connection_id, .. } => {
            let conn = pool.get(connection_id).await?;
            let paths = build_remote_index(&conn, &root.path).await?;
            let key = index_key(&root.source, &root.path);
            index.store(key, paths).await?;
        }
    }
    Ok(())
}

/// 파일명 인덱스 검색 — 캐시 있으면 즉시(오프라인 가능), 없으면 온디맨드 빌드 후 쿼리.
#[tauri::command]
#[specta::specta]
pub async fn index_search(
    root: Location,
    pattern: String,
    opts: SearchOpts,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    index: tauri::State<'_, Arc<FileIndex>>,
) -> Result<Vec<SearchHit>, DuetError> {
    if pattern.trim().is_empty() {
        return Ok(vec![]);
    }
    // 1) 캐시(메모리/디스크) 있으면 즉시 — 라이브 연결 불필요.
    if let Some(hits) = index.query(&root.source, &root.path, &pattern, &opts).await {
        return Ok(hits);
    }
    // 2) 아직 인덱스 없음 → 온디맨드 빌드 후 재쿼리.
    build_index_for(&root, pool.inner(), index.inner()).await?;
    Ok(index
        .query(&root.source, &root.path, &pattern, &opts)
        .await
        .unwrap_or_default())
}

/// root 인덱스를 강제 재빌드(최신화). 연결돼 있어야 원격 빌드 가능.
#[tauri::command]
#[specta::specta]
pub async fn index_reindex(
    root: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    index: tauri::State<'_, Arc<FileIndex>>,
) -> Result<(), DuetError> {
    build_index_for(&root, pool.inner(), index.inner()).await
}

/// 인덱스가 신선하지 않으면(미빌드 또는 TTL 초과) 빌드. 검색 패널 오픈 시 미리 호출해
/// 첫 쿼리가 즉시 뜨고 결과가 stale 하지 않도록. 이미 신선하면 즉시 반환.
#[tauri::command]
#[specta::specta]
pub async fn index_ensure(
    root: Location,
    pool: tauri::State<'_, Arc<ConnectionPool>>,
    index: tauri::State<'_, Arc<FileIndex>>,
) -> Result<(), DuetError> {
    // 60초 이내 빌드면 재빌드 생략(과도한 재워크 방지). 그보다 오래됐거나 미빌드면 빌드.
    const TTL_MS: i64 = 60_000;
    if index.is_fresh(&root.source, &root.path, TTL_MS).await {
        return Ok(());
    }
    build_index_for(&root, pool.inner(), index.inner()).await
}
