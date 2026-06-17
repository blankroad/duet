//! 파일명 인덱스 — "Everything" 식 즉시 검색.
//!
//! Everything 의 쿼리 방식(메모리에 목록 + 빠른 substring 스캔)을 따른다. 단,
//! 수백만 파일(전체 드라이브) 규모에서 `Vec<{String,String,String}>` 은 메모리가
//! 폭발하므로 **콤팩트 버퍼**로 저장한다:
//! - `paths`  : 모든 전체경로를 이어붙인 단일 String + `path_off` (각 경로 시작 offset)
//! - `names_lower` : 소문자 파일명들을 이어붙인 단일 String + `name_off` (빠른 대소문자무시 매칭)
//! - `kinds/sizes/mtimes` : 경로별 메타 (병렬 Vec, String 할당 없음)
//!
//! 이로써 String 수백만 개 할당을 피하고, 쿼리는 `names_lower` 슬라이스를 선형
//! `contains` 스캔 — Everything 과 동일한 in-memory 빠른 매칭. 새 의존성 없음.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::core::search::{SearchHit, SearchOpts};
use crate::services::settings::duet_config_dir;
use crate::types::{DuetError, EntryKind, Location, SourceId};

fn kind_to_u8(k: EntryKind) -> u8 {
    match k {
        EntryKind::File => 0,
        EntryKind::Dir => 1,
        EntryKind::Symlink => 2,
        EntryKind::Other => 3,
    }
}
fn u8_to_kind(b: u8) -> EntryKind {
    match b {
        1 => EntryKind::Dir,
        2 => EntryKind::Symlink,
        3 => EntryKind::Other,
        _ => EntryKind::File,
    }
}

/// 콤팩트 인덱스 — 한 source(+root)의 전체 파일 경로를 버퍼로 압축 저장.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CompactIndex {
    built_at_ms: i64,
    /// 전체경로 이어붙임. `[path_off[i]..path_off[i+1]]` = i번째 경로.
    paths: String,
    path_off: Vec<u32>,
    /// 소문자 파일명 이어붙임 (대소문자무시 매칭용).
    names_lower: String,
    name_off: Vec<u32>,
    kinds: Vec<u8>,
    sizes: Vec<u64>,
    /// `i64::MIN` = None.
    mtimes: Vec<i64>,
}

impl CompactIndex {
    fn count(&self) -> usize {
        self.kinds.len()
    }
}

/// 콤팩트 인덱스 빌더 — 워크/find 가 항목을 push, 끝나면 finish.
#[derive(Default)]
struct CompactBuilder {
    paths: String,
    path_off: Vec<u32>,
    names_lower: String,
    name_off: Vec<u32>,
    kinds: Vec<u8>,
    sizes: Vec<u64>,
    mtimes: Vec<i64>,
}

impl CompactBuilder {
    fn new() -> Self {
        let mut b = Self::default();
        b.path_off.push(0);
        b.name_off.push(0);
        b
    }
    fn push(&mut self, p: &IndexedPath) {
        let path_str = p.path.to_string_lossy();
        self.paths.push_str(&path_str);
        self.path_off.push(self.paths.len() as u32);
        let name_lower = p
            .path
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        self.names_lower.push_str(&name_lower);
        self.name_off.push(self.names_lower.len() as u32);
        self.kinds.push(kind_to_u8(p.kind));
        self.sizes.push(p.size);
        self.mtimes.push(p.modified_ms.unwrap_or(i64::MIN));
    }
    fn finish(self, built_at_ms: i64) -> CompactIndex {
        CompactIndex {
            built_at_ms,
            paths: self.paths,
            path_off: self.path_off,
            names_lower: self.names_lower,
            name_off: self.name_off,
            kinds: self.kinds,
            sizes: self.sizes,
            mtimes: self.mtimes,
        }
    }
}

/// source(+root)별 인덱스 보관소. Tauri State 로 등록.
pub struct FileIndex {
    inner: RwLock<HashMap<String, CompactIndex>>,
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

/// 전체 드라이브(로컬) 인덱스의 고정 키 — 어느 위치에서 검색하든 이 전역 인덱스를 쓴다.
pub const GLOBAL_LOCAL_KEY: &str = "local-global";

/// 인덱싱할 로컬 드라이브 루트들. Windows=존재하는 드라이브문자 루트, 그 외=`/`.
fn local_drive_roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .map(|c| PathBuf::from(format!("{}:\\", c as char)))
            .filter(|p| p.exists())
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![PathBuf::from("/")]
    }
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

    async fn load_from_disk(&self, key: &str) -> Option<CompactIndex> {
        let bytes = tokio::fs::read(self.cache_path(key)).await.ok()?;
        serde_json::from_slice(&bytes).ok()
    }

    /// 인덱스가 이미(메모리/디스크에) 있으면 true.
    pub async fn has(&self, key: &str) -> bool {
        if self.inner.read().await.contains_key(key) {
            return true;
        }
        self.cache_path(key).exists()
    }

    /// 인덱스가 신선한지 — 빌드돼 있고 마지막 빌드가 `ttl_ms` 이내. 메모리에 없으면
    /// 디스크에서 로드(캐싱)해 빌드 시각 확인. 미빌드면 false(빌드 필요).
    pub async fn is_fresh(&self, source: &SourceId, root: &Path, ttl_ms: i64) -> bool {
        let key = index_key(source, root);
        let built = self.inner.read().await.get(&key).map(|i| i.built_at_ms);
        let built = match built {
            Some(b) => b,
            None => match self.load_from_disk(&key).await {
                Some(idx) => {
                    let b = idx.built_at_ms;
                    self.inner.write().await.insert(key, idx);
                    b
                }
                None => return false,
            },
        };
        now_ms() - built < ttl_ms
    }

    /// 로컬 디렉토리 트리를 인덱싱(`ignore` 워크, .gitignore 존중). blocking 워크는
    /// spawn_blocking 으로 격리.
    pub async fn build_local(self: &Arc<Self>, root: &Path) -> Result<usize, DuetError> {
        let root = root.to_path_buf();
        let (root2, builder) = tokio::task::spawn_blocking(move || -> Result<_, DuetError> {
            let b = walk_local(&root)?;
            Ok((root, b))
        })
        .await
        .map_err(|e| DuetError::Io(format!("index build join: {e}")))??;
        let key = index_key(&SourceId::Local, &root2);
        self.store_compact(key, builder.finish(now_ms())).await
    }

    /// 이미 수집된 경로 목록(원격 `find` 등)을 인덱스에 저장 + 디스크 캐시.
    pub async fn store(
        self: &Arc<Self>,
        key: String,
        entries: Vec<IndexedPath>,
    ) -> Result<usize, DuetError> {
        let mut b = CompactBuilder::new();
        for e in &entries {
            b.push(e);
        }
        self.store_compact(key, b.finish(now_ms())).await
    }

    /// 모든 로컬 드라이브를 walk 해 **전역 인덱스**를 빌드(=Everything). 메모리에만 보관
    /// (수백 MB JSON 회피 — 바이너리 영속화는 후속). `on_progress(n)` 는 진행 파일 수를
    /// 주기적으로 받는다(UI 표시용).
    pub async fn build_global_local<F: Fn(u32) + Send + 'static>(
        self: &Arc<Self>,
        on_progress: F,
    ) -> Result<usize, DuetError> {
        let roots = local_drive_roots();
        let idx = tokio::task::spawn_blocking(move || {
            let mut b = CompactBuilder::new();
            let mut count = 0u32;
            for root in &roots {
                walk_into(&mut b, root, &mut count, &on_progress);
            }
            b.finish(now_ms())
        })
        .await
        .map_err(|e| DuetError::Io(format!("global index join: {e}")))?;
        let count = idx.count();
        // 전역 인덱스는 디스크 영속 생략(크기 큼) — 메모리에만.
        self.inner
            .write()
            .await
            .insert(GLOBAL_LOCAL_KEY.to_string(), idx);
        Ok(count)
    }

    /// 전역(전체 드라이브) 인덱스가 빌드돼 있으면 쿼리, 아니면 `None`.
    pub async fn query_global_local(
        &self,
        pattern: &str,
        opts: &SearchOpts,
    ) -> Option<Vec<SearchHit>> {
        let g = self.inner.read().await;
        g.get(GLOBAL_LOCAL_KEY)
            .map(|idx| run_query(idx, &SourceId::Local, pattern, opts))
    }

    async fn store_compact(
        self: &Arc<Self>,
        key: String,
        idx: CompactIndex,
    ) -> Result<usize, DuetError> {
        let count = idx.count();
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

/// 콤팩트 인덱스에서 파일명 substring 매칭 → SearchHit (Everything 식 빠른 선형 스캔).
fn run_query(
    idx: &CompactIndex,
    source: &SourceId,
    pattern: &str,
    opts: &SearchOpts,
) -> Vec<SearchHit> {
    let pat_lower = pattern.to_lowercase();
    let mut hits = Vec::new();
    let n = idx.count();
    for i in 0..n {
        let path = &idx.paths[idx.path_off[i] as usize..idx.path_off[i + 1] as usize];
        let matched = if opts.case_sensitive {
            // 대소문자 구분: 원본 파일명(경로 마지막 컴포넌트)으로 매칭.
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
            name.contains(pattern)
        } else {
            let nl = &idx.names_lower[idx.name_off[i] as usize..idx.name_off[i + 1] as usize];
            nl.contains(&pat_lower)
        };
        if !matched {
            continue;
        }
        let p = Path::new(path);
        let name = match p.file_name().and_then(|x| x.to_str()) {
            Some(x) => x.to_string(),
            None => continue,
        };
        let parent = match p.parent() {
            Some(x) => x.to_path_buf(),
            None => continue,
        };
        let mtime = idx.mtimes[i];
        hits.push(SearchHit {
            location: Location {
                source: source.clone(),
                path: parent,
            },
            name,
            kind: u8_to_kind(idx.kinds[i]),
            size: idx.sizes[i],
            modified_ms: if mtime == i64::MIN { None } else { Some(mtime) },
        });
        if hits.len() >= opts.max_results {
            break;
        }
    }
    hits
}

/// 인덱스에 넣을 한 경로의 메타 — 빌드 단계가 채워서 넘김.
pub struct IndexedPath {
    pub path: PathBuf,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

/// 한 root 트리를 walk 해 builder 에 push. `.gitignore` 존중. 5000개마다 진행률 콜백.
fn walk_into<F: Fn(u32)>(b: &mut CompactBuilder, root: &Path, count: &mut u32, on_progress: &F) {
    use ignore::WalkBuilder;
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_exclude(true)
        .build();
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
        b.push(&IndexedPath {
            path: path.to_path_buf(),
            kind,
            size,
            modified_ms,
        });
        *count += 1;
        if count.is_multiple_of(5000) {
            on_progress(*count);
        }
    }
}

/// 로컬 트리 워크 → CompactBuilder (단일 root, 진행률 없음). blocking.
fn walk_local(root: &Path) -> Result<CompactBuilder, DuetError> {
    let mut b = CompactBuilder::new();
    let mut count = 0u32;
    walk_into(&mut b, root, &mut count, &|_| {});
    Ok(b)
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
        let a = hits.iter().find(|h| h.name == "alpha2.rs").unwrap();
        assert_eq!(a.location.path, dir.path().join("sub"));
        assert_eq!(a.kind, EntryKind::File);
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

    #[tokio::test]
    async fn store_from_paths_and_query() {
        let cache = tempdir().unwrap();
        let idx = FileIndex::new(cache.path().to_path_buf());
        let key = index_key(&ssh_source(), Path::new("/home/u"));
        idx.store(
            key,
            vec![
                IndexedPath {
                    path: PathBuf::from("/home/u/notes.txt"),
                    kind: EntryKind::File,
                    size: 0,
                    modified_ms: None,
                },
                IndexedPath {
                    path: PathBuf::from("/home/u/sub/notes2.md"),
                    kind: EntryKind::File,
                    size: 0,
                    modified_ms: None,
                },
            ],
        )
        .await
        .unwrap();
        let hits = idx
            .query(
                &ssh_source(),
                Path::new("/home/u"),
                "notes",
                &SearchOpts::default(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 2);
    }
}
