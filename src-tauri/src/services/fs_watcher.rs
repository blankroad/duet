//! 파일시스템 변경 감시 서비스.
//!
//! 패널별로 현재 보고 있는 location 을 등록하면 (`set_pane_location`):
//! - **Local**: `notify::RecommendedWatcher` 가 path 를 NonRecursive 로 watch.
//!   변경 (Create/Modify/Remove) 감지 시 즉시 `FsChangedEvent` emit.
//! - **SSH**: 백그라운드 tokio task 가 `SSH_POLL_INTERVAL` 마다 SFTP stat 으로
//!   디렉토리 mtime 비교. 변화 시 emit. 비활성 패널은 폴링 안 함.
//!
//! 패널 location 변경 시 이전 watch 는 자동 해제 (notify unwatch / task abort).
//!
//! ## 한계
//!
//! - SSH 폴링은 디렉토리 mtime 만 체크 — 디렉토리 자체에 add/remove/rename
//!   은 잡지만, 디렉토리 내부 파일의 내용 변경 (size/mtime 변화) 은 일부
//!   파일시스템에서 못 잡음. MVP-1 수준에서는 충분.
//! - Local notify 는 NonRecursive — 현재 디렉토리만, 하위는 무시. 하위까지
//!   필요하면 후속에서 RecursiveMode::Recursive + 필터링.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use notify::{recommended_watcher, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::services::connection_pool::ConnectionPool;
use crate::services::fs_events::FsChangedEvent;
use crate::types::{ConnectionId, Location, SourceId};

/// SSH 디렉토리 mtime 폴링 간격. 3초 — 활성 패널에서 합리적인 반응성.
const SSH_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// 패널 한 개의 watch 상태.
enum Entry {
    Local {
        path: PathBuf,
    },
    Ssh {
        task: JoinHandle<()>,
        #[allow(dead_code)]
        path: PathBuf,
    },
}

impl Entry {
    fn cleanup(self, watcher: &mut RecommendedWatcher) {
        match self {
            Entry::Local { path } => {
                if let Err(e) = watcher.unwatch(&path) {
                    warn!("notify unwatch {}: {e}", path.display());
                }
            }
            Entry::Ssh { task, .. } => {
                task.abort();
            }
        }
    }
}

/// 패널별 watch 상태 관리.
pub struct FsWatcher {
    inner: Mutex<Inner>,
}

struct Inner {
    watcher: RecommendedWatcher,
    /// pane_id (PaneId 의 String 표현, e.g. "left"/"right") → Entry
    entries: HashMap<String, Entry>,
}

impl FsWatcher {
    /// 새 watcher 생성.
    ///
    /// `app` 은 notify 콜백이 캡처해서 emit 에 사용.
    pub fn new(app: AppHandle) -> Result<Arc<Self>, notify::Error> {
        let app_for_callback = app.clone();
        let watcher = recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(e) => e,
                Err(e) => {
                    warn!("notify error: {e}");
                    return;
                }
            };
            // Access 류는 무시 — 디렉토리 listing 에 영향 없음.
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            for path in event.paths {
                let _ = FsChangedEvent {
                    source: SourceId::Local,
                    path: path.to_string_lossy().into_owned(),
                }
                .emit(&app_for_callback);
            }
        })?;

        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                watcher,
                entries: HashMap::new(),
            }),
        }))
    }

    /// 특정 패널의 watch 위치를 설정. `None` 이면 watch 해제.
    /// 같은 패널의 이전 watch 는 자동 cleanup.
    pub async fn set_pane_location(
        self: &Arc<Self>,
        pane_id: String,
        location: Option<Location>,
        app: AppHandle,
        pool: Arc<ConnectionPool>,
    ) {
        let mut inner = self.inner.lock().await;

        if let Some(prev) = inner.entries.remove(&pane_id) {
            prev.cleanup(&mut inner.watcher);
        }

        let Some(location) = location else { return };

        match &location.source {
            SourceId::Local => {
                let path = location.path.clone();
                match inner.watcher.watch(&path, RecursiveMode::NonRecursive) {
                    Ok(()) => {
                        inner.entries.insert(pane_id, Entry::Local { path });
                    }
                    Err(e) => {
                        // path 가 존재 안 하거나 권한 없을 때 — silently skip.
                        // 사용자가 navigate 시 list_directory 가 별도로 에러 표시.
                        warn!("notify watch {}: {e}", path.display());
                    }
                }
            }
            SourceId::Ssh { connection_id, .. } => {
                let task = spawn_ssh_poll_task(
                    pool,
                    app,
                    connection_id.clone(),
                    location.source.clone(),
                    location.path.clone(),
                );
                inner.entries.insert(
                    pane_id,
                    Entry::Ssh {
                        task,
                        path: location.path,
                    },
                );
            }
        }
    }

    /// (테스트용) 현재 등록된 패널 수.
    #[cfg(test)]
    pub async fn entry_count(&self) -> usize {
        self.inner.lock().await.entries.len()
    }
}

/// SSH 폴링 task 시작. 디렉토리 mtime 변화 감지 시 emit.
fn spawn_ssh_poll_task(
    pool: Arc<ConnectionPool>,
    app: AppHandle,
    conn_id: ConnectionId,
    source: SourceId,
    path: PathBuf,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let path_str = path.to_string_lossy().into_owned();
        let mut last_mtime: Option<u32> = None;

        loop {
            tokio::time::sleep(SSH_POLL_INTERVAL).await;

            let Ok(mtime) = stat_dir_mtime(&pool, &conn_id, &path_str).await else {
                // 일시적 실패 (재연결 중 등) — 다음 tick 에서 재시도.
                continue;
            };

            let changed = match last_mtime {
                None => false, // 첫 polling 은 baseline 만 잡고 emit 안 함
                Some(prev) => mtime != prev,
            };
            last_mtime = Some(mtime);

            if changed {
                let _ = FsChangedEvent {
                    source: source.clone(),
                    path: path_str.clone(),
                }
                .emit(&app);
            }
        }
    })
}

/// SFTP 로 디렉토리 mtime 조회. 실패 시 Err — caller 가 무시하고 다음 tick.
async fn stat_dir_mtime(
    pool: &Arc<ConnectionPool>,
    conn_id: &ConnectionId,
    path: &str,
) -> Result<u32, ()> {
    let conn = pool.get(conn_id).await.map_err(|_| ())?;
    let session_mutex = conn.session.as_ref().ok_or(())?;

    let channel = {
        let handle = session_mutex.lock().await;
        let ch = handle.channel_open_session().await.map_err(|_| ())?;
        ch.request_subsystem(true, "sftp").await.map_err(|_| ())?;
        ch
    };

    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|_| ())?;

    let meta = sftp.metadata(path.to_string()).await.map_err(|_| ())?;
    meta.mtime.ok_or(())
}

#[cfg(test)]
mod tests {
    // Tauri AppHandle 없이 단위 테스트 어려움 — 통합 테스트는 후속.
    // 컴파일 시그니처 검증만.

    #[test]
    fn fs_watcher_new_signature() {
        let _ = super::FsWatcher::new;
    }

    #[test]
    fn fs_watcher_set_pane_location_signature() {
        let _ = super::FsWatcher::set_pane_location;
    }
}
