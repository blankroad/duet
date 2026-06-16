//! 파일명 인덱스 — "Everything" 식 즉시·오프라인 검색.
//!
//! source+root 별로 파일 경로 목록을 **인메모리**에 들고(=Everything 의 쿼리 방식:
//! RAM 리스트 + 빠른 선형 매칭), 디스크에 캐시한다. 쿼리는 라이브 연결 없이
//! 캐시 인덱스만으로 즉시 처리 — 원격 서버가 꺼져 있어도 검색된다.
//!
//! 빌드/갱신은 Everything 과 다르다(MFT/USN 은 NTFS·로컬 전용): 로컬은 `ignore`
//! 워크, 원격은 `find` 1회. 증분 갱신은 후속(현재는 온디맨드 빌드 + 수동 재색인).
//!
//! 자료구조: 사전 소문자화(`name_lower`)로 대소문자 무시 매칭을 빠르게. 새 의존성 없음.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::core::search::{SearchHit, SearchOpts};
use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, EntryKind, Location, SourceId};

/// 인덱스 엔트리 — SearchHit 재구성에 필요한 최소 정보 + 매칭용 소문자 이름.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntry {
    /// 전체 경로 (parent + name 은 여기서 파생).
    path: PathBuf,
    /// 파일명 (표시/대소문자 구분 매칭).
    name: String,
    /// 소문자 파일명 (대소문자 무시 매칭 — 매 쿼리 lowercasing 회피).
    name_lower: String,
    kind: EntryKind,
    size: u64,
    modified_ms: Option<i64>,
}

/// 한 source+root 의 인덱스.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SourceIndex {
    root: PathBuf,
    entries: Vec<IndexEntry>,
    built_at_ms: i64,
}

/// source(+root)별 인덱스 보관소. Tauri State 로 등록.
pub struct FileIndex {
    inner: RwLock<HashMap<String, SourceIndex>>,
    /// 디스크 캐시 디렉토리 (`<config>/duet/index` 또는 테스트용 임시 dir).
    cache_dir: PathBuf,
}

/// source + root → 캐시 키. SSH 는 connection_id(세션마다 바뀜) 대신 host_ip+user
/// 로 키잉해 재접속·오프라인에서도 캐시를 재사용한다.
pub fn index_key(source: &SourceId, root: &Path) -> String {
    let root = root.to_string_lossy();
    match source {
        SourceId::Local => format!("local|{root}"),
        SourceId::Ssh { host_ip, user, .. } => format!("ssh|{host_ip}|{user}|{root}"),
    }
}

/// 키를 파일명 안전 형태로(슬래시/콜론 등 → `_`). 디스크 캐시 파일명용.
fn key_to_filename(key: &str) -> String {
    let safe: String = key
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    format!("{safe}.json")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl FileIndex {
    /// 명시적 캐시 디렉토리로 생성 (테스트는 임시 dir 주입).
    pub fn new(cache_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            inner: RwLock::new(HashMap::new()),
            cache_dir,
        })
    }

    /// 프로덕션 — 캐시 디렉토리 `<config>/duet/index`.
    pub fn load_default() -> Result<Arc<Self>, DuetError> {
        Ok(Self::new(duet_config_dir()?.join("index")))
    }

    fn cache_path(&self, key: &str) -> PathBuf {
        self.cache_dir.join(key_to_filename(key))
    }

    async fn load_from_disk(&self, key: &str) -> Option<SourceIndex> {
        let bytes = tokio::fs::read(self.cache_path(key)).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// 인덱스가 이미(메모리/디스크에) 있으면 true. 빌드 필요 판단용.
    pub async fn has(&self, key: &str) -> bool {
        if self.inner.read().await.contains_key(key) {
            return true;
        }
        self.cache_path(key).exists()
    }

    /// 로컬 디렉토리 트리를 인덱싱(`ignore` 워크, .gitignore 존중). blocking I/O 라
    /// spawn_blocking 에서 호출됨을 가정하지 않고 내부에서 처리.
    pub async fn build_local(self: &Arc<Self>, root: &Path) -> Result<usize, DuetError> {
        let root = root.to_path_buf();
        let entries = tokio::task::spawn_blocking(move || walk_local(&root))
            .await
            .map_err(|e| DuetError::Io(format!("index build join: {e}")))??;
        let key = index_key(&SourceId::Local, &entries.0);
        self.store(key, entries.0, entries.1).await
    }

    /// 이미 수집된 (root, 경로목록)을 인덱스에 저장 + 디스크 캐시. 원격 빌드(커맨드에서
    /// `find` 출력 파싱 후)도 이 경로로 들어온다.
    pub async fn store(
        self: &Arc<Self>,
        key: String,
        root: PathBuf,
        entries: Vec<IndexedPath>,
    ) -> Result<usize, DuetError> {
        let entries: Vec<IndexEntry> = entries.into_iter().map(IndexEntry::from).collect();
        let count = entries.len();
        let idx = SourceIndex {
            root,
            entries,
            built_at_ms: now_ms(),
        };
        // 디스크 캐시(best-effort — 실패해도 메모리 인덱스는 유효).
        let path = self.cache_path(&key);
        if let Some(parent) = path.parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        if let Ok(json) = serde_json::to_vec(&idx) {
            let _ = tokio::fs::write(&path, json).await;
        }
        self.inner.write().await.insert(key, idx);
        Ok(count)
    }

    /// 인덱스 쿼리 — 라이브 연결 불필요(캐시만으로). 메모리에 없으면 디스크에서 로드.
    /// 둘 다 없으면 `None`(호출자가 빌드 후 재시도).
    pub async fn query(
        &self,
        source: &SourceId,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
    ) -> Option<Vec<SearchHit>> {
        let key = index_key(source, root);
        // 메모리 → 없으면 디스크 로드.
        {
            let guard = self.inner.read().await;
            if let Some(idx) = guard.get(&key) {
                return Some(run_query(idx, source, pattern, opts));
            }
        }
        let loaded = self.load_from_disk(&key).await?;
        let hits = run_query(&loaded, source, pattern, opts);
        self.inner.write().await.insert(key, loaded);
        Some(hits)
    }
}

/// 인메모리 인덱스에서 substring 매칭 → SearchHit (Everything 식 빠른 선형 스캔).
fn run_query(
    idx: &SourceIndex,
    source: &SourceId,
    pattern: &str,
    opts: &SearchOpts,
) -> Vec<SearchHit> {
    let pat_lower = pattern.to_lowercase();
    let mut hits = Vec::new();
    for e in &idx.entries {
        let matched = if opts.case_sensitive {
            e.name.contains(pattern)
        } else {
            e.name_lower.contains(&pat_lower)
        };
        if !matched {
            continue;
        }
        let parent = match e.path.parent() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        hits.push(SearchHit {
            location: Location {
                source: source.clone(),
                path: parent,
            },
            name: e.name.clone(),
            kind: e.kind,
            size: e.size,
            modified_ms: e.modified_ms,
        });
        if hits.len() >= opts.max_results {
            break;
        }
    }
    hits
}

/// 인덱스에 넣을 한 경로의 메타 — 빌드 단계가 채워서 `store` 로 넘김.
pub struct IndexedPath {
    pub path: PathBuf,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

impl From<IndexedPath> for IndexEntry {
    fn from(p: IndexedPath) -> Self {
        let name = p
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name_lower = name.to_lowercase();
        IndexEntry {
            path: p.path,
            name,
            name_lower,
            kind: p.kind,
            size: p.size,
            modified_ms: p.modified_ms,
        }
    }
}

/// 로컬 트리 워크 → (root, 경로목록). `.gitignore` 존중. blocking.
fn walk_local(root: &Path) -> Result<(PathBuf, Vec<IndexedPath>), DuetError> {
    use ignore::WalkBuilder;
    let walker = WalkBuilder::new(root)
        .hidden(false) // 인덱스는 숨김 포함해 담고, 쿼리 시점 필터링은 후속(현재 미사용)
        .git_ignore(true)
        .git_exclude(true)
        .build();
    let mut out = Vec::new();
    for entry in walker.flatten() {
        let path = entry.path();
        if path == root {
            continue;
        }
        let meta = entry.metadata().ok();
        let kind = match entry.file_type() {
            Some(t) if t.is_dir() => EntryKind::Dir,
            Some(t) if t.is_symlink() => EntryKind::Symlink,
            Some(t) if t.is_file() => EntryKind::File,
            _ => EntryKind::Other,
        };
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_ms = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        out.push(IndexedPath {
            path: path.to_path_buf(),
            kind,
            size,
            modified_ms,
        });
    }
    Ok((root.to_path_buf(), out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};
    use tempfile::tempdir;

    fn ssh_source() -> SourceId {
        SourceId::Ssh {
            connection_id: crate::types::ConnectionId("c1".into()),
            host_ip: IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            user: "u".into(),
        }
    }

    #[test]
    fn index_key_local_vs_ssh_and_stable_across_connection() {
        let root = Path::new("/srv/data");
        let local = index_key(&SourceId::Local, root);
        assert!(local.starts_with("local|"));
        // 같은 host_ip+user+root 면 connection_id 가 달라도 키 동일(오프라인 재사용).
        let a = index_key(&ssh_source(), root);
        let b = index_key(
            &SourceId::Ssh {
                connection_id: crate::types::ConnectionId("DIFFERENT".into()),
                host_ip: IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
                user: "u".into(),
            },
            root,
        );
        assert_eq!(a, b);
        assert_ne!(a, local);
    }

    #[tokio::test]
    async fn build_local_then_query_matches() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("alpha.txt"), b"x").unwrap();
        std::fs::write(dir.path().join("beta.md"), b"x").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("alpha2.rs"), b"x").unwrap();

        let cache = tempdir().unwrap();
        let idx = FileIndex::new(cache.path().to_path_buf());
        let n = idx.build_local(dir.path()).await.unwrap();
        assert!(n >= 3);

        let hits = idx
            .query(
                &SourceId::Local,
                dir.path(),
                "alpha",
                &SearchOpts::default(),
            )
            .await
            .expect("indexed");
        let mut names: Vec<&str> = hits.iter().map(|h| h.name.as_str()).collect();
        names.sort_unstable();
        assert_eq!(names, vec!["alpha.txt", "alpha2.rs"]);
        // 클릭 navigate 대상은 부모 디렉토리.
        let a = hits.iter().find(|h| h.name == "alpha2.rs").unwrap();
        assert_eq!(a.location.path, dir.path().join("sub"));
    }

    #[tokio::test]
    async fn query_returns_none_when_not_indexed() {
        let cache = tempdir().unwrap();
        let idx = FileIndex::new(cache.path().to_path_buf());
        let r = idx
            .query(
                &SourceId::Local,
                Path::new("/nonexistent-unindexed-xyz"),
                "q",
                &SearchOpts::default(),
            )
            .await;
        assert!(r.is_none());
    }

    #[tokio::test]
    async fn case_sensitivity_respected() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("ReadMe.md"), b"x").unwrap();
        let cache = tempdir().unwrap();
        let idx = FileIndex::new(cache.path().to_path_buf());
        idx.build_local(dir.path()).await.unwrap();
        // 기본(무시) → 매칭
        let ci = idx
            .query(
                &SourceId::Local,
                dir.path(),
                "readme",
                &SearchOpts::default(),
            )
            .await
            .unwrap();
        assert_eq!(ci.len(), 1);
        // 구분 → 불일치
        let cs = idx
            .query(
                &SourceId::Local,
                dir.path(),
                "readme",
                &SearchOpts {
                    case_sensitive: true,
                    ..SearchOpts::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(cs.len(), 0);
    }
}
