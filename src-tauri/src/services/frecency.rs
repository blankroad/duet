//! 디렉토리 frecency (frequency + recency) — zoxide 식 빈도·최근성 점프 랭킹.
//!
//! `<config_dir>/duet/frecency.json`. navigate 성공 시 `record`, 점퍼에서 `query`.
//! 점수 = `ln(count+1) / (1 + days_since_last_visit)` — 자주·최근일수록 높음.

use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, Location, SourceId};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// 보관 상한 — 초과 시 점수 하위 항목부터 prune.
const MAX_ENTRIES: usize = 1000;

/// frecency 항목 — 방문한 디렉토리 + 빈도/최근성.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct FrecencyEntry {
    /// 방문한 디렉토리 위치(로컬 또는 SSH).
    pub location: Location,
    /// SSH 면 호스트 alias — 재접속해도 안정적인 식별자.
    ///
    /// 예전에는 ephemeral `connection_id` 로만 키를 잡아, 재접속할 때마다 같은 폴더가
    /// 새 항목으로 쌓이고 예전 항목은 죽은 id 를 품은 채 남아 골라도 "열 수 없음" 이었다.
    #[serde(default)]
    pub host_alias: Option<String>,
    /// 누적 방문 횟수.
    pub count: u32,
    /// 마지막 방문 시각 (epoch ms, UTC).
    pub last_visit_ms: i64,
}

/// 소스+경로 식별 키 — dedup/조회용. SSH 는 **alias** 단위(재접속에 안정).
fn loc_key(loc: &Location, host_alias: Option<&str>) -> String {
    let src = match (&loc.source, host_alias) {
        (SourceId::Local, _) => "local".to_string(),
        (SourceId::Ssh { .. }, Some(alias)) => format!("ssh:{alias}"),
        // alias 를 모르는 항목(구버전 데이터)은 연결 id 로 — 로드 시 걸러진다.
        (SourceId::Ssh { connection_id, .. }, None) => format!("ssh?:{}", connection_id.0),
    };
    // NUL 구분자 — 경로/소스에 등장하지 않아 충돌 없음.
    format!("{src}\u{0}{}", loc.path.to_string_lossy())
}

/// frecency 점수 — 빈도 로그 × 최근성 감쇠. 높을수록 우선.
fn score(count: u32, last_visit_ms: i64, now_ms: i64) -> f64 {
    let days = ((now_ms - last_visit_ms).max(0) as f64) / 86_400_000.0;
    ((count as f64) + 1.0).ln() / (1.0 + days)
}

/// In-memory cache + on-disk JSON.
pub struct FrecencyStore {
    path: PathBuf,
    inner: RwLock<Vec<FrecencyEntry>>,
}

impl FrecencyStore {
    /// `<config_dir>/duet/frecency.json` 위치에 초기화 — 없으면 빈 목록.
    pub async fn load_default() -> Result<Arc<Self>, DuetError> {
        let path = duet_config_dir()?.join("frecency.json");
        Self::load_from(&path).await
    }

    /// 지정 경로에서 초기화. 파일 없음/파싱 실패면 빈 목록(손상 무시 — 캐시성 데이터).
    pub async fn load_from(path: &Path) -> Result<Arc<Self>, DuetError> {
        let entries = if path.exists() {
            tokio::fs::read_to_string(path)
                .await
                .ok()
                .filter(|t| !t.trim().is_empty())
                .and_then(|t| serde_json::from_str::<Vec<FrecencyEntry>>(&t).ok())
                .map(|v| {
                    // alias 없는 원격 항목은 구버전 데이터 — 죽은 connection_id 를 품고
                    // 있어 열면 실패한다. 조용히 버린다(캐시성 데이터).
                    v.into_iter()
                        .filter(|e| {
                            !matches!(e.location.source, SourceId::Ssh { .. })
                                || e.host_alias.is_some()
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        Ok(Arc::new(Self {
            path: path.to_path_buf(),
            inner: RwLock::new(entries),
        }))
    }

    /// 방문 기록 — 같은 위치면 count+1·최근성 갱신, 처음이면 추가. 상한 초과 시 prune.
    pub async fn record(
        &self,
        location: Location,
        host_alias: Option<String>,
        now_ms: i64,
    ) -> Result<(), DuetError> {
        let key = loc_key(&location, host_alias.as_deref());
        let mut v = self.inner.write().await;
        if let Some(e) = v
            .iter_mut()
            .find(|e| loc_key(&e.location, e.host_alias.as_deref()) == key)
        {
            e.count = e.count.saturating_add(1);
            e.last_visit_ms = now_ms;
        } else {
            v.push(FrecencyEntry {
                location,
                host_alias,
                count: 1,
                last_visit_ms: now_ms,
            });
        }
        if v.len() > MAX_ENTRIES {
            v.sort_by(|a, b| {
                score(b.count, b.last_visit_ms, now_ms)
                    .partial_cmp(&score(a.count, a.last_visit_ms, now_ms))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            v.truncate(MAX_ENTRIES);
        }
        let snap = v.clone();
        self.write_to_disk(&snap).await?;
        Ok(())
    }

    /// 부분문자열(경로, 대소문자 무시) 필터 후 score 내림차순 상위 `limit` 개.
    pub async fn query(&self, q: &str, limit: usize, now_ms: i64) -> Vec<FrecencyEntry> {
        let ql = q.trim().to_lowercase();
        let v = self.inner.read().await;
        let mut matched: Vec<FrecencyEntry> = v
            .iter()
            .filter(|e| {
                ql.is_empty()
                    || e.location
                        .path
                        .to_string_lossy()
                        .to_lowercase()
                        .contains(&ql)
            })
            .cloned()
            .collect();
        matched.sort_by(|a, b| {
            score(b.count, b.last_visit_ms, now_ms)
                .partial_cmp(&score(a.count, a.last_visit_ms, now_ms))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        matched.truncate(limit);
        matched
    }

    async fn write_to_disk(&self, items: &[FrecencyEntry]) -> Result<(), DuetError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(DuetError::from)?;
        }
        let text = serde_json::to_string_pretty(items)
            .map_err(|e| DuetError::Io(format!("frecency serialize: {e}")))?;
        tokio::fs::write(&self.path, text)
            .await
            .map_err(DuetError::from)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn loc(p: &str) -> Location {
        Location {
            source: SourceId::Local,
            path: PathBuf::from(p),
        }
    }

    #[tokio::test]
    async fn record_increments_and_persists() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("f.json");
        let s = FrecencyStore::load_from(&path).await.unwrap();
        s.record(loc("/home/u/proj"), None, 1000).await.unwrap();
        s.record(loc("/home/u/proj"), None, 2000).await.unwrap();
        // 재로드 후에도 count=2 유지
        let s2 = FrecencyStore::load_from(&path).await.unwrap();
        let all = s2.query("", 10, 3000).await;
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].count, 2);
        assert_eq!(all[0].last_visit_ms, 2000);
    }

    #[tokio::test]
    async fn query_substring_filters_path() {
        let dir = tempdir().unwrap();
        let s = FrecencyStore::load_from(&dir.path().join("f.json"))
            .await
            .unwrap();
        s.record(loc("/var/log"), None, 1000).await.unwrap();
        s.record(loc("/home/proj"), None, 1000).await.unwrap();
        let r = s.query("proj", 10, 2000).await;
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].location.path, PathBuf::from("/home/proj"));
    }

    #[tokio::test]
    async fn ranks_by_frecency() {
        let dir = tempdir().unwrap();
        let s = FrecencyStore::load_from(&dir.path().join("f.json"))
            .await
            .unwrap();
        // A: 많이·오래전, B: 적게·방금
        let now = 100 * 86_400_000;
        for _ in 0..10 {
            s.record(loc("/a"), None, 1).await.unwrap(); // 오래 전(거의 0)
        }
        s.record(loc("/b"), None, now).await.unwrap(); // 방금
        let r = s.query("", 10, now).await;
        // 최근성 감쇠로 방금 방문한 /b 가 위
        assert_eq!(r[0].location.path, PathBuf::from("/b"));
    }

    #[tokio::test]
    async fn distinct_sources_not_merged() {
        let dir = tempdir().unwrap();
        let s = FrecencyStore::load_from(&dir.path().join("f.json"))
            .await
            .unwrap();
        let ssh = Location {
            source: SourceId::Ssh {
                connection_id: crate::types::ConnectionId("c1".into()),
                host_ip: "10.0.0.1".parse().unwrap(),
                user: "u".into(),
            },
            path: PathBuf::from("/home/proj"),
        };
        s.record(loc("/home/proj"), None, 1000).await.unwrap();
        s.record(ssh, Some("prod".into()), 1000).await.unwrap();
        assert_eq!(s.query("", 10, 2000).await.len(), 2);
    }

    /// 재접속하면 connection_id 가 바뀌는데, 같은 호스트·경로는 한 항목으로 합쳐져야
    /// 한다 — 예전엔 접속할 때마다 새 항목이 쌓이고 예전 것은 열 수 없었다.
    #[tokio::test]
    async fn ssh_entries_merge_by_alias_across_reconnects() {
        let dir = tempdir().unwrap();
        let s = FrecencyStore::load_from(&dir.path().join("f.json"))
            .await
            .unwrap();
        let ssh_at = |conn: &str| Location {
            source: SourceId::Ssh {
                connection_id: crate::types::ConnectionId(conn.into()),
                host_ip: "10.0.0.1".parse().unwrap(),
                user: "u".into(),
            },
            path: PathBuf::from("/var/log"),
        };
        s.record(ssh_at("prod:aaa"), Some("prod".into()), 1000)
            .await
            .unwrap();
        s.record(ssh_at("prod:bbb"), Some("prod".into()), 2000)
            .await
            .unwrap();

        let hits = s.query("", 10, 3000).await;
        assert_eq!(hits.len(), 1, "재접속해도 한 항목이어야 함");
        assert_eq!(hits[0].count, 2);
        assert_eq!(hits[0].host_alias.as_deref(), Some("prod"));
    }

    /// alias 없는 구버전 원격 항목은 로드 시 버린다(죽은 connection_id).
    #[tokio::test]
    async fn legacy_ssh_entries_without_alias_are_dropped() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("f.json");
        let legacy = r#"[
          {"location":{"source":{"kind":"ssh","connection_id":"old:xyz",
            "host_ip":"10.0.0.1","user":"u"},"path":"/var/log"},
           "count":5,"last_visit_ms":1000},
          {"location":{"source":{"kind":"local"},"path":"/home/u"},
           "count":2,"last_visit_ms":1000}
        ]"#;
        tokio::fs::write(&path, legacy).await.unwrap();
        let s = FrecencyStore::load_from(&path).await.unwrap();
        let hits = s.query("", 10, 2000).await;
        assert_eq!(hits.len(), 1, "원격 구버전 항목은 버려야 함");
        assert!(matches!(hits[0].location.source, SourceId::Local));
    }
}
