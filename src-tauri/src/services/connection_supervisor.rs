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
                pool.end_reconnect(&id).await; // 이 reconnect 의 취소 토큰 정리(누수 방지)
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
    // 이 재연결 시도의 취소 토큰 — connection_close 가 cancel 하면 부활을 막는다.
    let cancel = pool.begin_reconnect(&id).await;
    for (i, delay) in BACKOFF_STEPS.iter().enumerate() {
        let _ = ConnectionStateEvent {
            id: id.clone(),
            alias: alias.clone(),
            host_ip: String::new(),
            user: user.clone(),
            state: ConnectionStateChange::Connecting,
        }
        .emit(&app);

        // 사용자가 close 하면 백오프 대기 중에도 즉시 중단.
        tokio::select! {
            _ = cancel.cancelled() => return,
            _ = tokio::time::sleep(*delay) => {}
        }

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
                // alias 가 config 에 없음 — 더는 시도 의미 없음. ad-hoc 연결은 처음부터
                // config 에 없으므로 "지워졌다" 가 아니라 미지원이라고 알린다.
                final_failure(
                    &pool,
                    &app,
                    &id,
                    &alias,
                    &user,
                    missing_alias_reason(&alias),
                )
                .await;
                return;
            }
        };

        // 재연결은 known_hosts 학습/교체 안 함 — 키가 바뀌었으면 조용히 신뢰하지 않고 실패.
        // connect 는 수초 IO — 그 사이 close 되면 즉시 중단.
        let connect_res = tokio::select! {
            _ = cancel.cancelled() => return,
            r = connect(&host, &all_hosts, false, false) => r,
        };
        match connect_res {
            Ok(session) => {
                // connect 동안 사용자가 close 했으면 insert 직전 재확인 — 끊긴 연결 부활 차단.
                if cancel.is_cancelled() {
                    return;
                }
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
    // 여기 닿는 건 마지막 시도까지 ~/.ssh/config 를 읽지 못한 경우뿐 — 종료 상태를
    // 알리지 않으면 프론트가 영원히 "연결 중" 에 머물고 재연결 버튼도 안 나온다.
    final_failure(
        &pool,
        &app,
        &id,
        &alias,
        &user,
        "could not read ~/.ssh/config while reconnecting",
    )
    .await;
}

/// `user@host:port` 형식인가 — `connection_open_adhoc` 이 만드는 alias.
/// port 는 마지막 `:` 뒤 숫자 (IPv6 호스트 대비).
fn is_adhoc_alias(alias: &str) -> bool {
    let Some((user, rest)) = alias.split_once('@') else {
        return false;
    };
    let Some((host, port)) = rest.rsplit_once(':') else {
        return false;
    };
    !user.is_empty() && !host.is_empty() && port.parse::<u16>().is_ok()
}

/// config 에서 alias 를 찾지 못했을 때 배너에 보일 이유.
fn missing_alias_reason(alias: &str) -> &'static str {
    if is_adhoc_alias(alias) {
        "automatic reconnect is not supported for directly entered hosts — press Reconnect"
    } else {
        "host alias removed from ~/.ssh/config"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adhoc_alias_is_detected() {
        assert!(is_adhoc_alias("root@10.0.0.5:22"));
        assert!(is_adhoc_alias("u@::1:2222"));
        assert!(!is_adhoc_alias("nas"));
        assert!(!is_adhoc_alias("u@host"));
        assert!(!is_adhoc_alias("@host:22"));
        assert!(!is_adhoc_alias("u@host:http"));
    }

    #[test]
    fn missing_alias_reason_matches_host_kind() {
        assert!(missing_alias_reason("u@box.lan:22").contains("not supported"));
        assert_eq!(
            missing_alias_reason("nas"),
            "host alias removed from ~/.ssh/config"
        );
    }
}
