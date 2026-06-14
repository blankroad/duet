//! 활성 연결의 health check + 자동 재연결.
//!
//! `connection_open` 성공 시 `spawn_supervisor` 가 호출되어 백그라운드 task 가
//! 시작된다. Task 는 5초 간격으로 `Handle::is_closed()` 폴링하고,
//! `russh` keepalive 가 끊김을 감지하면 (`keepalive_interval` × `keepalive_max`,
//! 약 45초) 백오프로 재연결 시도.
//!
//! 재연결 백오프: 1 → 2 → 4 → 8 → 16 → 30 (max) 초, 최대 6회 시도.
//! AuthFailed 는 즉시 포기 (자격증명이 갑자기 바뀔 일 없음).
//! 모든 시도 실패 시 pool 에서 제거 + Error 이벤트 emit.
//!
//! 재연결 성공 시 새 supervisor 를 spawn 해서 새 handle 도 감시.

use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tauri_specta::Event;
use tracing::{info, warn};

use crate::services::connection_events::{ConnectionStateChange, ConnectionStateEvent};
use crate::services::connection_pool::{ActiveConnection, ConnectionPool};
use crate::ssh::config::load_ssh_hosts;
use crate::ssh::connection::connect;
use crate::types::{ConnectionId, DuetError};

/// Health check 폴링 간격.
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_secs(5);

/// 백오프 단계. 마지막 단계 이후 재연결 포기.
const BACKOFF_STEPS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
    Duration::from_secs(30),
];

/// 새 supervisor task 를 백그라운드로 시작.
///
/// pool 에서 `id` 가 사라지면 (사용자 close) supervisor 자동 종료.
/// handle 끊김 감지 시 reconnect_loop 진입; 성공 시 새 supervisor 재spawn.
pub fn spawn_supervisor(pool: Arc<ConnectionPool>, app: AppHandle, id: ConnectionId) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;

            // pool 에서 사라졌으면 사용자가 명시 close — supervisor 종료.
            let conn = match pool.get(&id).await {
                Ok(c) => c,
                Err(_) => return,
            };
            let Some(session_mutex) = conn.session.as_ref() else {
                return;
            };

            // is_closed 는 동기 메서드 — 락 잡고 즉시 확인.
            let closed = {
                let handle = session_mutex.lock().await;
                handle.is_closed()
            };

            if closed {
                info!(connection = %id.0, "session closed — starting reconnect loop");
                let alias = conn.alias.clone();
                let user = conn.user.clone();
                drop(conn); // Arc 풀어서 새 insert 가 동기화 충돌 안 나도록
                reconnect_loop(pool.clone(), app.clone(), id.clone(), alias, user).await;
                return; // 성공이든 실패든 이 supervisor 는 종료 (성공 시 새 supervisor spawn 됨)
            }
        }
    });
}

/// 백오프 재연결 루프.
///
/// 시도마다 Connecting emit → sleep → connect 시도.
/// - 성공: pool 에 새 ActiveConnection insert + Connected emit + 새 supervisor spawn.
/// - AuthFailed: 즉시 종료 (Error emit + pool 제거).
/// - 그 외 에러: 다음 백오프 단계로.
/// - 마지막 단계도 실패: Error emit + pool 제거.
async fn reconnect_loop(
    pool: Arc<ConnectionPool>,
    app: AppHandle,
    id: ConnectionId,
    alias: String,
    user: String,
) {
    for (i, delay) in BACKOFF_STEPS.iter().enumerate() {
        let _ = ConnectionStateEvent {
            id: id.clone(),
            alias: alias.clone(),
            host_ip: String::new(),
            user: user.clone(),
            state: ConnectionStateChange::Connecting,
        }
        .emit(&app);

        tokio::time::sleep(*delay).await;

        // 매 시도마다 ssh config 재로드 — 사용자가 그 사이에 config 수정한
        // 경우도 반영. 비용은 작음.
        let all_hosts = match load_ssh_hosts() {
            Ok(h) => h,
            Err(e) => {
                warn!("reconnect: load_ssh_hosts failed: {e}");
                continue;
            }
        };
        let host = match all_hosts.iter().find(|h| h.alias == alias) {
            Some(h) => h.clone(),
            None => {
                // alias 가 config 에서 사라짐 — 더는 시도 의미 없음.
                final_failure(
                    &pool,
                    &app,
                    &id,
                    &alias,
                    &user,
                    "host alias removed from ~/.ssh/config",
                )
                .await;
                return;
            }
        };

        match connect(&host, &all_hosts).await {
            Ok(session) => {
                let host_ip = session.host_ip;
                let new_conn = ActiveConnection {
                    id: id.clone(),
                    alias: alias.clone(),
                    host_ip,
                    user: host.user.clone(),
                    session: Some(tokio::sync::Mutex::new(session.handle)),
                    rsync_available: tokio::sync::Mutex::new(None),
                    // 재연결이면 이전 browse 임시 디렉토리는 host-side 에 orphan 으로
                    // 남음(세션이 죽어 reap 불가) — 새 연결은 빈 추적으로 시작.
                    browse_temp_dirs: tokio::sync::Mutex::new(Vec::new()),
                };
                pool.insert(new_conn).await;

                let _ = ConnectionStateEvent {
                    id: id.clone(),
                    alias: alias.clone(),
                    host_ip: host_ip.to_string(),
                    user: host.user.clone(),
                    state: ConnectionStateChange::Connected,
                }
                .emit(&app);

                info!(connection = %id.0, attempt = i + 1, "reconnected");
                // 새 handle 을 감시할 supervisor 시작.
                spawn_supervisor(pool, app, id);
                return;
            }
            Err(DuetError::AuthFailed) => {
                final_failure(&pool, &app, &id, &alias, &user, "auth failed on reconnect").await;
                return;
            }
            Err(e) => {
                warn!("reconnect attempt {} failed: {e}", i + 1);
                // 다음 단계로 — 단, 마지막 단계였으면 final_failure.
                if i + 1 == BACKOFF_STEPS.len() {
                    final_failure(&pool, &app, &id, &alias, &user, &format!("{e}")).await;
                    return;
                }
            }
        }
    }
}

async fn final_failure(
    pool: &Arc<ConnectionPool>,
    app: &AppHandle,
    id: &ConnectionId,
    alias: &str,
    user: &str,
    reason: &str,
) {
    let _ = ConnectionStateEvent {
        id: id.clone(),
        alias: alias.to_string(),
        host_ip: String::new(),
        user: user.to_string(),
        state: ConnectionStateChange::Error {
            message: reason.to_string(),
        },
    }
    .emit(app);
    pool.remove(id).await;
    info!(connection = %id.0, reason, "reconnect gave up");
}
