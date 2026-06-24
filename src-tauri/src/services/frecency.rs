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
    /// 누적 방문 횟수.
    pub count: u32,
    /// 마지막 방문 시각 (epoch ms, UTC).
    pub last_visit_ms: i64,
}

/// 소스+경로 식별 키 — dedup/조회용. 소스는 로컬/connection 단위.
fn loc_key(loc: &Location) -> String {
    let src = match &loc.source {
        SourceId::Local => "local".to_string(),
        SourceId::Ssh { connection_id, .. } => format!("ssh:{}", connection_id.0),
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
    pub async fn record(&self, location: Location, now_ms: i64) -> Result<(), DuetError> {
        let key = loc_key(&location);
        let mut v = self.inner.write().await;
        if let Some(e) = v.iter_mut().find(|e| loc_key(&e.location) == key) {
            e.count = e.count.saturating_add(1);
            e.last_visit_ms = now_ms;
        } else {
            v.push(FrecencyEntry {
                location,
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
        s.record(loc("/home/u/proj"), 1000).await.unwrap();
        s.record(loc("/home/u/proj"), 2000).await.unwrap();
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
        s.record(loc("/var/log"), 1000).await.unwrap();
        s.record(loc("/home/proj"), 1000).await.unwrap();
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
            s.record(loc("/a"), 1).await.unwrap(); // 오래 전(거의 0)
        }
        s.record(loc("/b"), now).await.unwrap(); // 방금
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
        s.record(loc("/home/proj"), 1000).await.unwrap();
        s.record(ssh, 1000).await.unwrap();
        assert_eq!(s.query("", 10, 2000).await.len(), 2);
    }
}
