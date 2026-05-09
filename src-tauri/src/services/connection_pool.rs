//! SSH 활성 연결 풀.
//!
//! 한 ConnectionId 당 한 SSH session. `insert` 로 등록, `get` 으로 참조 획득.
//! 연결 끊김 watcher / 자동 재연결은 Task 13 에서 추가.

use crate::types::{ConnectionId, DuetError, SourceId};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use tokio::sync::RwLock;

/// 활성 SSH 연결 한 개의 메타데이터.
///
/// MVP-1 Task 3 에서 `session: Mutex<russh::client::Handle>` 필드 추가됨.
/// 지금은 metadata 만 — Task 7 의 connection_open command 작성 시점부터
/// 의미 있는 라이프사이클 시작.
#[derive(Debug, Clone)]
pub struct ActiveConnection {
    pub id: ConnectionId,
    pub alias: String,
    pub host_ip: IpAddr,
    pub user: String,
}

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
