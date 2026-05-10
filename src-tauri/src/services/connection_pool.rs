//! SSH 활성 연결 풀.
//!
//! 한 ConnectionId 당 한 SSH session. `insert` 로 등록, `get` 으로 참조 획득.
//! 연결 끊김 watcher / 자동 재연결은 Task 13 에서 추가.

use crate::ssh::connection::AcceptAllHandler;
use crate::types::{ConnectionId, DuetError, SourceId};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 활성 SSH 연결 한 개의 메타데이터 + 세션.
///
/// Task 3 에서 `session: Option<Mutex<Handle>>` 추가.
/// `None` 은 단위 테스트 전용 — 프로덕션 경로는 항상 `Some`.
/// Task 7 의 connection_open command 에서 실제 세션 수명 주기 시작.
pub struct ActiveConnection {
    pub id: ConnectionId,
    pub alias: String,
    pub host_ip: IpAddr,
    pub user: String,
    /// SSH session. None 인 경우는 테스트만 — 프로덕션 경로는 항상 Some.
    ///
    /// `Mutex` 로 동시 접근 직렬화 (russh Handle 자체는 Send 이나 Sync 아님).
    pub session: Option<tokio::sync::Mutex<russh::client::Handle<AcceptAllHandler>>>,
    /// rsync 가 원격에 설치되어 있는지 캐시.
    /// `None` = 미확인, `Some(true/false)` = 확인됨.
    /// MVP-3 same-host copy 의 첫 호출 때 detect 후 채움. 연결 재시작 시 reset.
    pub rsync_available: tokio::sync::Mutex<Option<bool>>,
}

/// Debug 수동 구현 — session 내용은 절대 출력하지 않음 (CLAUDE.md §5, 자격증명 보호).
impl std::fmt::Debug for ActiveConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActiveConnection")
            .field("id", &self.id)
            .field("alias", &self.alias)
            .field("host_ip", &self.host_ip)
            .field("user", &self.user)
            .field("session", &"<russh::Handle>")
            .field("rsync_available", &"<cached>")
            .finish()
    }
}

// Clone 제거 — russh::Handle 은 Clone 아님. Pool 안에서 Arc<ActiveConnection> 으로 공유.

impl ActiveConnection {
    /// SourceId::Ssh 로 변환 — FileSystem trait 의 source_id() 구현용.
    pub fn source_id(&self) -> SourceId {
        SourceId::Ssh {
            connection_id: self.id.clone(),
            host_ip: self.host_ip,
            user: self.user.clone(),
        }
    }
}

/// 활성 연결들을 관리. Tauri State 로 등록 — `tauri::State<Arc<ConnectionPool>>`.
#[derive(Default)]
pub struct ConnectionPool {
    inner: RwLock<HashMap<ConnectionId, Arc<ActiveConnection>>>,
}

impl ConnectionPool {
    /// 새 빈 풀을 `Arc` 로 감싸서 반환.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 연결 추가. 같은 id 가 이미 있으면 덮어쓰기 (재연결 케이스).
    pub async fn insert(&self, conn: ActiveConnection) {
        let id = conn.id.clone();
        self.inner.write().await.insert(id, Arc::new(conn));
    }

    /// id 로 조회. 없으면 `DuetError::ConnectionFailed`.
    pub async fn get(&self, id: &ConnectionId) -> Result<Arc<ActiveConnection>, DuetError> {
        self.inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| DuetError::ConnectionFailed(format!("no connection: {}", id.0)))
    }

    /// 연결 제거. 없어도 에러 아님 (idempotent).
    pub async fn remove(&self, id: &ConnectionId) {
        self.inner.write().await.remove(id);
    }

    /// 모든 활성 연결 목록.
    pub async fn list(&self) -> Vec<Arc<ActiveConnection>> {
        self.inner.read().await.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_conn(id: &str, ip: &str) -> ActiveConnection {
        ActiveConnection {
            id: ConnectionId(id.to_string()),
            alias: id.to_string(),
            host_ip: ip.parse().unwrap(),
            user: "test".to_string(),
            session: None, // 단위 테스트 전용 — 실제 SSH 서버 불필요
            rsync_available: tokio::sync::Mutex::new(None),
        }
    }

    #[tokio::test]
    async fn insert_get_remove() {
        let pool = ConnectionPool::new();
        pool.insert(mk_conn("a", "10.0.0.1")).await;

        let got = pool.get(&ConnectionId("a".into())).await.unwrap();
        assert_eq!(got.alias, "a");
        assert_eq!(got.host_ip.to_string(), "10.0.0.1");

        pool.remove(&ConnectionId("a".into())).await;
        assert!(pool.get(&ConnectionId("a".into())).await.is_err());
    }

    #[tokio::test]
    async fn list_returns_all() {
        let pool = ConnectionPool::new();
        pool.insert(mk_conn("a", "10.0.0.1")).await;
        pool.insert(mk_conn("b", "10.0.0.2")).await;
        let all = pool.list().await;
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn get_nonexistent_returns_connection_failed() {
        let pool = ConnectionPool::new();
        let result = pool.get(&ConnectionId("nope".into())).await;
        assert!(matches!(result, Err(DuetError::ConnectionFailed(_))));
    }

    #[tokio::test]
    async fn source_id_round_trips() {
        let conn = mk_conn("a", "10.0.0.1");
        let sid = conn.source_id();
        match sid {
            SourceId::Ssh {
                connection_id,
                host_ip,
                user,
            } => {
                assert_eq!(connection_id.0, "a");
                assert_eq!(host_ip.to_string(), "10.0.0.1");
                assert_eq!(user, "test");
            }
            _ => panic!("expected SourceId::Ssh"),
        }
    }

    #[tokio::test]
    async fn insert_overwrites_same_id() {
        let pool = ConnectionPool::new();
        pool.insert(mk_conn("a", "10.0.0.1")).await;
        pool.insert(mk_conn("a", "10.0.0.99")).await; // 같은 id, 다른 IP
        let got = pool.get(&ConnectionId("a".into())).await.unwrap();
        assert_eq!(got.host_ip.to_string(), "10.0.0.99");
    }
}
