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

    /// i번째 항목의 전체 경로.
    fn path_at(&self, i: usize) -> &str {
        &self.paths[self.path_off[i] as usize..self.path_off[i + 1] as usize]
    }

    /// i번째 항목의 소문자 파일명.
    fn name_lower_at(&self, i: usize) -> &str {
        &self.names_lower[self.name_off[i] as usize..self.name_off[i + 1] as usize]
    }

    /// 디스크 캐시에서 읽은 인덱스의 구조 검사 — 배열 길이·오프셋이 어긋나면 검색 중
    /// 범위 밖 인덱싱·문자 경계 slice 로 panic 한다(SC-26). 어긋나면 캐시를 버리고 새로 만든다.
    fn is_consistent(&self) -> bool {
        let n = self.count();
        self.sizes.len() == n
            && self.mtimes.len() == n
            && offsets_ok(&self.path_off, &self.paths, n)
            && offsets_ok(&self.name_off, &self.names_lower, n)
    }
}

/// `off` 가 `n + 1` 개, 0 에서 시작해 단조 증가, `buf.len()` 에서 끝나고 모두 문자 경계인지.
fn offsets_ok(off: &[u32], buf: &str, n: usize) -> bool {
    off.len() == n + 1
        && off.first() == Some(&0)
        && off.last().map(|&e| e as usize) == Some(buf.len())
        && off.windows(2).all(|w| w[0] <= w[1])
        && off.iter().all(|&o| buf.is_char_boundary(o as usize))
}

/// 콤팩트 인덱스 빌더 — 워크/find 가 항목을 push, 끝나면 finish.
#[derive(Default, Clone)]
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
            // NFC 로 정규화 후 소문자(G-14) — macOS NFD 한글 이름도 NFC 입력으로 찾게.
            .map(|n| crate::core::search::nfc_key(&n.to_string_lossy()).to_lowercase())
            .unwrap_or_default();
        self.names_lower.push_str(&name_lower);
        self.name_off.push(self.names_lower.len() as u32);
        self.kinds.push(kind_to_u8(p.kind));
        self.sizes.push(p.size);
        self.mtimes.push(p.modified_ms.unwrap_or(i64::MIN));
    }
    /// 다른 인덱스의 i번째 항목을 그대로 복사(경로·이름 재계산 없음).
    fn push_from(&mut self, src: &CompactIndex, i: usize) {
        self.paths.push_str(src.path_at(i));
        self.path_off.push(self.paths.len() as u32);
        self.names_lower.push_str(src.name_lower_at(i));
        self.name_off.push(self.names_lower.len() as u32);
        self.kinds.push(src.kinds[i]);
        self.sizes.push(src.sizes[i]);
        self.mtimes.push(src.mtimes[i]);
    }
    /// 지금까지 push 된 항목으로 콤팩트 인덱스 스냅샷(빌더는 그대로 유지).
    /// 전체 드라이브 워크 도중 "부분 공개"용 — 검색이 빌드 완료를 안 기다려도 됨.
    fn snapshot(&self, built_at_ms: i64) -> CompactIndex {
        CompactIndex {
            built_at_ms,
            paths: self.paths.clone(),
            path_off: self.path_off.clone(),
            names_lower: self.names_lower.clone(),
            name_off: self.name_off.clone(),
            kinds: self.kinds.clone(),
            sizes: self.sizes.clone(),
            mtimes: self.mtimes.clone(),
        }
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
    /// 진행 중인 전역 빌드와, 그 빌드들보다 늦게 시작한 폴더 재색인 기록(SC-18).
    overlays: std::sync::Mutex<OverlayState>,
}

/// 전역 빌드의 공개(부분·최종)는 빌드 시작 뒤에 읽은 목록이지만, 그 사이 끝난 폴더 재색인보다
/// 오래된 내용일 수 있다. 그래서 빌드보다 **늦게 시작한** 재색인은 기록해 두고 그 빌드가 공개할
/// 때마다 다시 덮어 쓴다. 순서는 벽시계(ms 충돌) 대신 단조 증가 순번으로 정한다.
#[derive(Default)]
struct OverlayState {
    next_seq: u64,
    /// 진행 중인 전역 빌드들의 시작 순번.
    active_builds: Vec<u64>,
    /// 재색인 기록 — 진행 중인 빌드 중 이보다 먼저 시작한 것이 있을 때만 남는다.
    reindexed: Vec<ReindexOverlay>,
}

impl OverlayState {
    fn take_seq(&mut self) -> u64 {
        let s = self.next_seq;
        self.next_seq += 1;
        s
    }

    /// 어떤 진행 중 빌드도 필요로 하지 않는 기록을 버린다 — 기록은 자기보다 먼저 시작한
    /// 빌드에만 필요하다. 빌드가 없으면 전부 버린다.
    fn prune(&mut self) {
        match self.active_builds.iter().min().copied() {
            Some(oldest) => self.reindexed.retain(|o| o.seq > oldest),
            None => self.reindexed.clear(),
        }
    }
}

/// 폴더 재색인 한 건. `seq` 는 그 재색인이 폴더를 읽기 시작할 때의 순번.
struct ReindexOverlay {
    root: PathBuf,
    seq: u64,
    fresh: CompactIndex,
}

/// `global` 에서 `root` 아래(자기 자신 제외) 항목을 빼고 `fresh` 항목을 붙인 새 인덱스.
fn splice_subtree(global: &CompactIndex, root: &Path, fresh: &CompactIndex) -> CompactIndex {
    let mut b = CompactBuilder::new();
    for i in 0..global.count() {
        let path = Path::new(global.path_at(i));
        if path != root && path.starts_with(root) {
            continue;
        }
        b.push_from(global, i);
    }
    for i in 0..fresh.count() {
        b.push_from(fresh, i);
    }
    b.finish(global.built_at_ms)
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
/// `_` 치환은 `a-b`·`a_b` 같은 다른 root 를 같은 이름으로 만드므로 원래 키의 해시를 붙인다(SC-25).
/// 읽기 좋은 앞부분은 길이를 잘라 파일명 길이 한도(255)를 넘지 않게 한다.
fn key_to_filename(key: &str) -> String {
    let safe: String = key
        .chars()
        // ASCII 만 남겨 길이(바이트)를 고정 상한으로 — 한글 경로도 파일명 255바이트 안에 든다.
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(120)
        .collect();
    format!("{safe}-{:016x}.json", fnv1a64(key.as_bytes()))
}

/// FNV-1a 64비트 — 앱 버전과 무관하게 같은 값(캐시 파일명이 재시작 뒤에도 같아야 한다).
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// `path` 가 숨김 항목(점으로 시작하는 이름)이거나 그 아래에 있는지. `base` 아래 경로면 `base`
/// 이후 부분만 본다 — 사용자가 이미 `~/.config` 안에서 검색하면 그 안의 항목은 숨김이 아니다.
/// Windows 숨김 속성은 인덱스에 저장하지 않아 반영하지 않는다(점 이름만).
fn is_hidden_below(path: &Path, base: &Path) -> bool {
    let rel = path.strip_prefix(base).unwrap_or(path);
    rel.components().any(|c| match c {
        std::path::Component::Normal(n) => n.to_string_lossy().starts_with('.'),
        _ => false,
    })
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 전체 드라이브(로컬) 인덱스의 고정 키 — 어느 위치에서 검색하든 이 전역 인덱스를 쓴다.
pub const GLOBAL_LOCAL_KEY: &str = "local-global";

/// 전역 인덱스를 처음 "부분 공개"하는 파일 수 임계치. 이후 공개마다 2배로 늘린다
/// (누적 스냅샷 복사비용 ≈ O(n)). 큰 단일 드라이브(C:)에서도 이 임계치마다
/// 검색이 전체-PC 범위로 즉시 전환된다.
const FIRST_PUBLISH_AT: u32 = 20_000;

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
            overlays: std::sync::Mutex::new(OverlayState::default()),
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
        let idx: CompactIndex = serde_json::from_slice(&bytes).ok()?;
        if idx.is_consistent() {
            Some(idx)
        } else {
            tracing::warn!("index cache {key}: inconsistent structure, ignoring");
            None
        }
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
        // 읽기 시작 시점의 순번 — 이보다 늦게 시작한 전역 빌드는 이 재색인보다 새 내용을 읽는다.
        let seq = self.overlay_state().take_seq();
        let (root2, builder) = tokio::task::spawn_blocking(move || -> Result<_, DuetError> {
            let b = walk_local(&root)?;
            Ok((root, b))
        })
        .await
        .map_err(|e| DuetError::Io(format!("index build join: {e}")))??;
        let fresh = builder.finish(now_ms());
        // 전역 인덱스가 있으면 그 root 아래 부분을 방금 읽은 목록으로 갈아 끼운다(SC-18).
        // 로컬 검색은 전역 인덱스를 우선 쓰므로, 안 그러면 [재색인] 결과가 검색에 안 보인다.
        self.splice_into_global(&root2, &fresh, seq).await;
        let key = index_key(&SourceId::Local, &root2);
        self.store_compact(key, fresh).await
    }

    /// 전역 인덱스에서 `root` 아래 항목을 `fresh` 로 바꾼다. 이 재색인보다 먼저 시작한 전역 빌드가
    /// 진행 중이면 그 빌드의 다음 공개에도 다시 적용되도록 기록한다. 전역이 아직 없으면 기록만 한다.
    /// 잠금 순서: `inner` → `overlays` (publish_global 과 같다).
    async fn splice_into_global(&self, root: &Path, fresh: &CompactIndex, seq: u64) {
        let mut guard = self.inner.write().await;
        {
            let mut st = self.overlay_state();
            if st.active_builds.iter().any(|&b| b < seq) {
                // 같은 폴더·그 하위의 더 오래된 기록은 이번 것으로 대체된다.
                st.reindexed
                    .retain(|o| !(o.root.starts_with(root) && o.seq < seq));
                st.reindexed.push(ReindexOverlay {
                    root: root.to_path_buf(),
                    seq,
                    fresh: fresh.clone(),
                });
            }
        }
        let Some(global) = guard.get(GLOBAL_LOCAL_KEY) else {
            return;
        };
        let next = splice_subtree(global, root, fresh);
        guard.insert(GLOBAL_LOCAL_KEY.to_string(), next);
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
    ///
    /// 핵심: 빌드 도중 **부분 공개**한다 — 첫 임계치(또는 첫 드라이브 완료) 직후부터
    /// `query_global_local` 이 전체-PC(인덱싱된 만큼) 결과를 돌려준다. 그래서 검색이
    /// "지금 연 폴더"로 폴백되지 않고 곧바로 호스트 전체 범위가 된다.
    pub async fn build_global_local<F: Fn(u32) + Send + 'static>(
        self: &Arc<Self>,
        on_progress: F,
    ) -> Result<usize, DuetError> {
        self.build_global_from_roots(local_drive_roots(), on_progress)
            .await
    }

    /// `build_global_local` 의 본체 — root 목록을 주입받는다(테스트는 임시 dir 주입).
    async fn build_global_from_roots<F: Fn(u32) + Send + 'static>(
        self: &Arc<Self>,
        roots: Vec<PathBuf>,
        on_progress: F,
    ) -> Result<usize, DuetError> {
        let this = self.clone();
        let started = self.begin_global_build();
        let count = tokio::task::spawn_blocking(move || {
            let mut b = CompactBuilder::new();
            let mut count = 0u32;
            let mut next_publish: u32 = FIRST_PUBLISH_AT;
            {
                // 큰 드라이브 도중 임계치마다 부분 공개(임계치는 2배씩 증가).
                let mut tick = |builder: &CompactBuilder, c: u32| {
                    on_progress(c);
                    if c >= next_publish {
                        this.publish_global(builder.snapshot(now_ms()), started);
                        next_publish = next_publish.saturating_mul(2);
                    }
                };
                for root in &roots {
                    walk_into(&mut b, root, &mut count, &mut tick);
                    // 드라이브 1개 끝날 때마다 무조건 공개 — 작은/여러 드라이브도 즉시 전체-PC.
                    this.publish_global(b.snapshot(now_ms()), started);
                }
            }
            let final_idx = b.finish(now_ms());
            let c = final_idx.count();
            this.publish_global(final_idx, started);
            c
        })
        .await;
        self.end_global_build(started);
        let count = count.map_err(|e| DuetError::Io(format!("global index join: {e}")))?;
        Ok(count)
    }

    /// 재색인 기록 잠금. 독(poison)돼도 안의 값은 일관된 상태라 그대로 쓴다.
    fn overlay_state(&self) -> std::sync::MutexGuard<'_, OverlayState> {
        self.overlays
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// 전역 빌드 시작 — 시작 순번을 등록하고 돌려준다.
    fn begin_global_build(&self) -> u64 {
        let mut st = self.overlay_state();
        let s = st.take_seq();
        st.active_builds.push(s);
        s
    }

    /// 전역 빌드 끝(성공·실패 모두) — 등록을 빼고 더는 필요 없는 재색인 기록을 버린다.
    fn end_global_build(&self, started: u64) {
        let mut st = self.overlay_state();
        if let Some(i) = st.active_builds.iter().position(|&b| b == started) {
            st.active_builds.swap_remove(i);
        }
        st.prune();
    }

    /// 전역(전체 드라이브) 인덱스를 갱신 — 부분/최종 모두 같은 키로 덮어쓴다.
    /// 이 빌드(`started`)보다 늦게 시작한 폴더 재색인은 더 새 목록이라 순번 순서대로 다시 덮어 쓴다(SC-18).
    /// blocking 컨텍스트(spawn_blocking 내부)에서 호출 가능하도록 `blocking_write` 사용.
    fn publish_global(&self, mut idx: CompactIndex, started: u64) {
        let mut guard = self.inner.blocking_write();
        {
            let st = self.overlay_state();
            let mut newer: Vec<&ReindexOverlay> =
                st.reindexed.iter().filter(|o| o.seq > started).collect();
            newer.sort_by_key(|o| o.seq);
            for o in newer {
                idx = splice_subtree(&idx, &o.root, &o.fresh);
            }
        }
        guard.insert(GLOBAL_LOCAL_KEY.to_string(), idx);
    }

    /// 전역(전체 드라이브) 인덱스가 빌드돼 있으면 쿼리, 아니면 `None`.
    /// `scope` 는 검색을 시작한 폴더 — 숨김 판정의 기준(그 아래는 상대 경로로 본다).
    pub async fn query_global_local(
        &self,
        scope: &Path,
        pattern: &str,
        opts: &SearchOpts,
    ) -> Option<Vec<SearchHit>> {
        let g = self.inner.read().await;
        g.get(GLOBAL_LOCAL_KEY)
            .map(|idx| run_query(idx, &SourceId::Local, scope, pattern, opts))
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
    /// 둘 다 없으면 `None`(호출자가 빌드 후 재시도). 원격 인덱스는 경로만 수집하므로
    /// 메타 필터 요청은 캐시 유무와 관계없이 명시적 오류로 거부한다.
    pub async fn query(
        &self,
        source: &SourceId,
        root: &Path,
        pattern: &str,
        opts: &SearchOpts,
    ) -> Result<Option<Vec<SearchHit>>, DuetError> {
        if matches!(source, SourceId::Ssh { .. })
            && (opts.only_kind.is_some()
                || opts.min_size.is_some()
                || opts.max_size.is_some()
                || opts.modified_after_ms.is_some()
                || opts.modified_before_ms.is_some())
        {
            return Err(DuetError::NotSupported(
                "Remote filename indexes do not contain file type, size, or modification time. Clear these filters to search by name.".into(),
            ));
        }
        let key = index_key(source, root);
        {
            let guard = self.inner.read().await;
            if let Some(idx) = guard.get(&key) {
                return Ok(Some(run_query(idx, source, root, pattern, opts)));
            }
        }
        let Some(loaded) = self.load_from_disk(&key).await else {
            return Ok(None);
        };
        let hits = run_query(&loaded, source, root, pattern, opts);
        self.inner.write().await.insert(key, loaded);
        Ok(Some(hits))
    }
}

/// 콤팩트 인덱스에서 파일명 substring 매칭 → SearchHit (Everything 식 빠른 선형 스캔).
fn run_query(
    idx: &CompactIndex,
    source: &SourceId,
    scope: &Path,
    pattern: &str,
    opts: &SearchOpts,
) -> Vec<SearchHit> {
    // 검색어의 NFC·NFD 두 형태로 찾는다(G-14). NFD 형태는 정규화 전에 만든 디스크 캐시
    // (이름이 원본 그대로 소문자)와 대소문자 구분 모드(원본 이름)를 위한 것이다.
    let forms = crate::core::search::pattern_forms(pattern);
    let forms_lower: Vec<String> = forms.iter().map(|p| p.to_lowercase()).collect();
    let mut hits = Vec::new();
    let n = idx.count();
    for i in 0..n {
        let path = idx.path_at(i);
        let matched = if opts.case_sensitive {
            // 대소문자 구분: 원본 파일명(경로 마지막 컴포넌트)으로 매칭.
            let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
            forms.iter().any(|p| name.contains(p.as_str()))
        } else {
            let nl = idx.name_lower_at(i);
            forms_lower.iter().any(|p| nl.contains(p.as_str()))
        };
        if !matched {
            continue;
        }
        let p = Path::new(path);
        // 인덱스는 숨김까지 모두 담는다 — "숨김 포함" 이 꺼져 있으면 여기서 뺀다(SC-27).
        if !opts.include_hidden && is_hidden_below(p, scope) {
            continue;
        }
        let name = match p.file_name().and_then(|x| x.to_str()) {
            Some(x) => x.to_string(),
            None => continue,
        };
        let parent = match p.parent() {
            Some(x) => x.to_path_buf(),
            None => continue,
        };
        let mtime = idx.mtimes[i];
        let modified_ms = if mtime == i64::MIN { None } else { Some(mtime) };
        // 크기·수정시각·종류 필터 — 인덱스가 이미 들고 있는 값이라 추가 I/O 없음.
        if !opts.accepts(u8_to_kind(idx.kinds[i]), idx.sizes[i], modified_ms) {
            continue;
        }
        hits.push(SearchHit {
            location: Location {
                source: source.clone(),
                path: parent,
            },
            name,
            kind: u8_to_kind(idx.kinds[i]),
            size: idx.sizes[i],
            modified_ms,
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

/// 한 root 트리를 walk 해 builder 에 push. `.gitignore` 존중. 5000개마다 `tick(&builder,
/// count)` 호출 — 진행률 표시 + (전역 빌드 시) 부분 공개 스냅샷에 쓰인다.
fn walk_into<F: FnMut(&CompactBuilder, u32)>(
    b: &mut CompactBuilder,
    root: &Path,
    count: &mut u32,
    tick: &mut F,
) {
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
            tick(b, *count);
        }
    }
}

/// 로컬 트리 워크 → CompactBuilder (단일 root, 부분 공개 없음). blocking.
fn walk_local(root: &Path) -> Result<CompactBuilder, DuetError> {
    let mut b = CompactBuilder::new();
    let mut count = 0u32;
    walk_into(&mut b, root, &mut count, &mut |_, _| {});
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};
    use tempfile::tempdir;

    #[test]
    fn built_index_is_consistent_and_broken_offsets_are_not() {
        let mut b = CompactBuilder::new();
        b.push(&IndexedPath {
            path: PathBuf::from("/a/한글.txt"),
            kind: EntryKind::File,
            size: 1,
            modified_ms: None,
        });
        let good = b.finish(0);
        assert!(good.is_consistent());

        let mut short = good.clone();
        short.mtimes.clear();
        assert!(!short.is_consistent());

        // "/a/한" 중간(멀티바이트 문자 안쪽)을 가리키는 오프셋 — slice 하면 panic 했을 것.
        let mut mid_char = good.clone();
        mid_char.path_off = vec![0, 4, good.paths.len() as u32];
        mid_char.kinds.push(0);
        mid_char.sizes.push(0);
        mid_char.mtimes.push(0);
        mid_char.name_off.push(good.names_lower.len() as u32);
        assert!(!mid_char.is_consistent());

        let mut empty_off = good;
        empty_off.path_off.clear();
        assert!(!empty_off.is_consistent());
    }

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

    /// G-14: 색인 검색도 NFC/NFD 차이를 무시한다(대소문자 무시·구분 모두). 표시 이름은 원본.
    #[tokio::test]
    async fn query_ignores_nfc_nfd_difference() {
        use unicode_normalization::UnicodeNormalization;
        let dir = tempdir().unwrap();
        let nfd: String = "회의록.txt".nfd().collect();
        std::fs::write(dir.path().join(&nfd), b"x").unwrap();
        let cache = tempdir().unwrap();
        let idx = FileIndex::new(cache.path().to_path_buf());
        idx.build_local(dir.path()).await.unwrap();
        for case_sensitive in [false, true] {
            let opts = SearchOpts {
                case_sensitive,
                ..Default::default()
            };
            let q: String = "회의".nfc().collect();
            let hits = idx
                .query(&SourceId::Local, dir.path(), &q, &opts)
                .await
                .unwrap()
                .expect("indexed");
            assert_eq!(hits.len(), 1, "cs={case_sensitive}");
            assert_eq!(hits[0].name, nfd);
        }
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
            .unwrap()
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
        assert!(r.unwrap().is_none());
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
            .unwrap()
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
            .unwrap()
            .unwrap();
        assert_eq!(cs.len(), 0);
    }

    #[tokio::test]
    async fn global_index_covers_all_roots_regardless_of_query_location() {
        // 두 개의 "드라이브"(임시 dir)를 전역 인덱스로 묶으면, 어느 위치 기준이든
        // 양쪽 모두 검색돼야 한다 — 폴더 단위가 아니라 호스트(PC) 단위.
        // tempfile 기본 이름은 `.tmpXXXX`(숨김) — 숨김 제외 검색에 걸리지 않게 접두를 바꾼다.
        let d1 = tempfile::Builder::new()
            .prefix("duetidx")
            .tempdir()
            .unwrap();
        let d2 = tempfile::Builder::new()
            .prefix("duetidx")
            .tempdir()
            .unwrap();
        std::fs::write(d1.path().join("onlyone_alpha.txt"), b"x").unwrap();
        std::fs::write(d2.path().join("onlyone_beta.txt"), b"x").unwrap();

        let cache = tempdir().unwrap();
        let idx = FileIndex::new(cache.path().to_path_buf());
        let n = idx
            .build_global_from_roots(vec![d1.path().into(), d2.path().into()], |_| {})
            .await
            .unwrap();
        assert!(n >= 2);

        let a = idx
            .query_global_local(Path::new("/"), "onlyone_alpha", &SearchOpts::default())
            .await
            .expect("global built");
        assert_eq!(a.len(), 1);
        let b = idx
            .query_global_local(Path::new("/"), "onlyone_beta", &SearchOpts::default())
            .await
            .expect("global built");
        assert_eq!(b.len(), 1);
        // 공통 접두어 — 두 드라이브에 걸친 결과가 한 번에 나와야 함.
        let both = idx
            .query_global_local(Path::new("/"), "onlyone", &SearchOpts::default())
            .await
            .expect("global built");
        assert_eq!(both.len(), 2);
    }

    #[test]
    fn compact_builder_snapshot_is_partial_view() {
        // 부분 공개 메커니즘: 빌드 도중 스냅샷은 그때까지 push 된 항목만 담는다.
        let mut b = CompactBuilder::new();
        let mk = |name: &str| IndexedPath {
            path: PathBuf::from("/r").join(name),
            kind: EntryKind::File,
            size: 0,
            modified_ms: None,
        };
        b.push(&mk("aa.txt"));
        b.push(&mk("ab.txt"));
        let snap = b.snapshot(0);
        assert_eq!(snap.count(), 2);
        b.push(&mk("ac.txt"));
        let full = b.finish(0);
        assert_eq!(full.count(), 3);

        let partial = run_query(
            &snap,
            &SourceId::Local,
            Path::new("/"),
            "a",
            &SearchOpts::default(),
        );
        assert_eq!(partial.len(), 2);
        let complete = run_query(
            &full,
            &SourceId::Local,
            Path::new("/"),
            "a",
            &SearchOpts::default(),
        );
        assert_eq!(complete.len(), 3);
    }

    #[tokio::test]
    async fn remote_metadata_filters_fail_before_cache_lookup_and_after_disk_reload() {
        let cache = tempdir().unwrap();
        let root = Path::new("/fixture");
        let source = ssh_source();
        let idx = FileIndex::new(cache.path().to_path_buf());
        let filters = [
            SearchOpts {
                only_kind: Some(EntryKind::Dir),
                ..Default::default()
            },
            SearchOpts {
                only_kind: Some(EntryKind::File),
                ..Default::default()
            },
            SearchOpts {
                min_size: Some(1),
                ..Default::default()
            },
            // Unknown size must not masquerade as an actual zero-byte file.
            SearchOpts {
                max_size: Some(0),
                ..Default::default()
            },
            SearchOpts {
                modified_after_ms: Some(0),
                ..Default::default()
            },
            SearchOpts {
                modified_before_ms: Some(1000),
                ..Default::default()
            },
        ];
        for opts in &filters {
            assert!(matches!(
                idx.query(&source, root, "item", opts).await,
                Err(DuetError::NotSupported(_))
            ));
        }
        idx.store(
            index_key(&source, root),
            vec![IndexedPath {
                path: root.join("item"),
                kind: EntryKind::File,
                size: 0,
                modified_ms: None,
            }],
        )
        .await
        .unwrap();
        let reloaded = FileIndex::new(cache.path().to_path_buf());
        for index in [&idx, &reloaded] {
            for opts in &filters {
                assert!(matches!(
                    index.query(&source, root, "item", opts).await,
                    Err(DuetError::NotSupported(_))
                ));
            }
            // Offline name-only search remains available from memory and disk.
            let hits = index
                .query(&source, root, "item", &SearchOpts::default())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(hits.len(), 1);
        }
    }

    #[tokio::test]
    async fn local_index_keeps_real_zero_size_kind_and_date_filters() {
        let cache = tempdir().unwrap();
        let root = Path::new("/fixture");
        let idx = FileIndex::new(cache.path().to_path_buf());
        idx.store(
            index_key(&SourceId::Local, root),
            vec![
                IndexedPath {
                    path: root.join("item_empty"),
                    kind: EntryKind::File,
                    size: 0,
                    modified_ms: Some(1000),
                },
                IndexedPath {
                    path: root.join("item_large"),
                    kind: EntryKind::File,
                    size: 2000,
                    modified_ms: Some(2000),
                },
                IndexedPath {
                    path: root.join("item_dir"),
                    kind: EntryKind::Dir,
                    size: 0,
                    modified_ms: Some(2000),
                },
            ],
        )
        .await
        .unwrap();
        for (opts, expected) in [
            (
                SearchOpts {
                    max_size: Some(0),
                    only_kind: Some(EntryKind::File),
                    ..Default::default()
                },
                "item_empty",
            ),
            (
                SearchOpts {
                    min_size: Some(1000),
                    modified_after_ms: Some(1500),
                    only_kind: Some(EntryKind::File),
                    ..Default::default()
                },
                "item_large",
            ),
            (
                SearchOpts {
                    only_kind: Some(EntryKind::Dir),
                    ..Default::default()
                },
                "item_dir",
            ),
        ] {
            let hits = idx
                .query(&SourceId::Local, root, "item", &opts)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].name, expected);
        }
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
            .unwrap()
            .unwrap();
        assert_eq!(hits.len(), 2);
    }
}

#[cfg(test)]
mod ux_smoke_browse {
    use super::*;

    #[tokio::test]
    async fn reindex_splice_drops_deleted_and_keeps_other_roots() {
        let a = tempfile::Builder::new()
            .prefix("duetidx")
            .tempdir()
            .unwrap();
        let b = tempfile::Builder::new()
            .prefix("duetidx")
            .tempdir()
            .unwrap();
        let cache = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("gone_needle"), b"x").unwrap();
        std::fs::write(b.path().join("other_needle"), b"x").unwrap();
        let idx = FileIndex::new(cache.path().into());
        idx.build_global_from_roots(vec![a.path().into(), b.path().into()], |_| {})
            .await
            .unwrap();
        std::fs::remove_file(a.path().join("gone_needle")).unwrap();
        std::fs::write(a.path().join("fresh_needle"), b"x").unwrap();
        idx.build_local(a.path()).await.unwrap();
        let names = |hits: Vec<SearchHit>| -> Vec<String> {
            let mut v: Vec<String> = hits.into_iter().map(|h| h.name).collect();
            v.sort();
            v
        };
        let hits = idx
            .query_global_local(a.path(), "needle", &SearchOpts::default())
            .await
            .unwrap();
        assert_eq!(names(hits), vec!["fresh_needle", "other_needle"]);
    }

    /// 동기 테스트용 — publish_global 은 blocking 이라 async 테스트 안에서 부를 수 없다.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn hits(rt: &tokio::runtime::Runtime, idx: &FileIndex, dir: &Path, pat: &str) -> usize {
        rt.block_on(idx.query_global_local(dir, pat, &SearchOpts::default()))
            .unwrap()
            .len()
    }

    fn plain_dir() -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix("duetidx")
            .tempdir()
            .unwrap()
    }

    /// 전역 빌드 도중 재색인: 그 빌드가 나중에 공개하는 (재색인 전에 읽은) 스냅샷이
    /// 재색인 결과를 지우면 안 된다(Sol R1-02).
    #[test]
    fn global_publish_during_build_keeps_completed_reindex() {
        let rt = rt();
        let dir = plain_dir();
        let cache = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old_needle"), b"x").unwrap();
        let idx = FileIndex::new(cache.path().into());
        let a = idx.begin_global_build();
        let stale = walk_local(dir.path()).unwrap().finish(0);
        idx.publish_global(stale.clone(), a);
        std::fs::write(dir.path().join("new_needle"), b"x").unwrap();
        rt.block_on(idx.build_local(dir.path())).unwrap();
        assert_eq!(hits(&rt, &idx, dir.path(), "new_needle"), 1);
        idx.publish_global(stale.clone(), a);
        assert_eq!(
            hits(&rt, &idx, dir.path(), "new_needle"),
            1,
            "partial publish"
        );
        idx.publish_global(stale, a);
        assert_eq!(
            hits(&rt, &idx, dir.path(), "new_needle"),
            1,
            "final publish"
        );
        idx.end_global_build(a);
        assert!(
            idx.overlay_state().reindexed.is_empty(),
            "no build left → no records"
        );
    }

    /// Sol R2-01: 늦게 시작한 빌드 B 가 먼저 끝나도, 아직 도는 옛 빌드 A 에 필요한 기록은 남는다.
    #[test]
    fn newer_build_finishing_first_keeps_records_for_older_build() {
        let rt = rt();
        let dir = plain_dir();
        let cache = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old_needle"), b"x").unwrap();
        let idx = FileIndex::new(cache.path().into());
        let a = idx.begin_global_build();
        let stale = walk_local(dir.path()).unwrap().finish(0);
        idx.publish_global(stale.clone(), a);
        std::fs::write(dir.path().join("new_needle"), b"x").unwrap();
        rt.block_on(idx.build_local(dir.path())).unwrap();
        let b = idx.begin_global_build();
        let fresh = walk_local(dir.path()).unwrap().finish(0);
        idx.publish_global(fresh, b);
        idx.end_global_build(b);
        idx.publish_global(stale, a);
        assert_eq!(hits(&rt, &idx, dir.path(), "new_needle"), 1);
        idx.end_global_build(a);
    }

    /// Sol R2-02: 빌드가 끝난 뒤 남은 옛 기록이 그 뒤의 재색인·새 빌드를 덮으면 안 된다
    /// (벽시계 같은 ms 라도 순번으로 구분).
    #[test]
    fn finished_build_records_cannot_override_later_reindex() {
        let rt = rt();
        let dir = plain_dir();
        let cache = tempfile::tempdir().unwrap();
        let idx = FileIndex::new(cache.path().into());
        let a = idx.begin_global_build();
        idx.publish_global(CompactBuilder::new().finish(0), a);
        std::fs::write(dir.path().join("one_needle"), b"x").unwrap();
        rt.block_on(idx.build_local(dir.path())).unwrap();
        idx.end_global_build(a);
        std::fs::remove_file(dir.path().join("one_needle")).unwrap();
        std::fs::write(dir.path().join("two_needle"), b"x").unwrap();
        rt.block_on(idx.build_local(dir.path())).unwrap();
        let b = idx.begin_global_build();
        idx.publish_global(walk_local(dir.path()).unwrap().finish(0), b);
        idx.end_global_build(b);
        assert_eq!(hits(&rt, &idx, dir.path(), "two_needle"), 1);
        assert_eq!(hits(&rt, &idx, dir.path(), "one_needle"), 0);
    }

    #[test]
    fn cache_name_stays_short_for_long_unicode_roots() {
        let root = format!(
            "local|/{}/{}/{}",
            "가".repeat(40),
            "나".repeat(40),
            "다".repeat(40)
        );
        assert!(key_to_filename(&root).len() <= 160);
    }

    #[test]
    fn hidden_is_judged_below_the_search_folder() {
        let base = Path::new("/home/u/.config");
        assert!(!is_hidden_below(Path::new("/home/u/.config/app/x"), base));
        assert!(is_hidden_below(Path::new("/home/u/.config/.git/x"), base));
        assert!(is_hidden_below(
            Path::new("/home/u/.cache/x"),
            Path::new("/home/u/p")
        ));
        assert!(!is_hidden_below(
            Path::new("/home/u/p/x"),
            Path::new("/home/u/p")
        ));
    }

    #[tokio::test]
    async fn global_query_hides_dot_entries_unless_asked() {
        let d = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        std::fs::create_dir(d.path().join(".git")).unwrap();
        std::fs::write(d.path().join(".git/needle_in_git"), b"x").unwrap();
        std::fs::write(d.path().join("needle_plain"), b"x").unwrap();
        let idx = FileIndex::new(cache.path().into());
        idx.build_global_from_roots(vec![d.path().into()], |_| {})
            .await
            .unwrap();
        let hits = idx
            .query_global_local(d.path(), "needle", &SearchOpts::default())
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        let opts = SearchOpts {
            include_hidden: true,
            ..Default::default()
        };
        let hits = idx
            .query_global_local(d.path(), "needle", &opts)
            .await
            .unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn cache_names_differ_for_lossy_equal_keys() {
        assert_ne!(key_to_filename("local|/a-b"), key_to_filename("local|/a_b"));
        assert!(key_to_filename(&"x".repeat(1000)).len() < 200);
    }
}

#[cfg(test)]
mod review_sync_compare {
    use super::*;

    #[tokio::test]
    async fn global_results_reflect_folder_reindex() {
        let dir = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old_needle"), b"x").unwrap();
        let idx = FileIndex::new(cache.path().into());
        idx.build_global_from_roots(vec![dir.path().into()], |_| {})
            .await
            .unwrap();
        std::fs::write(dir.path().join("new_needle"), b"x").unwrap();
        // index_reindex/index_ensure call build_local, while index_search still prefers global.
        idx.build_local(dir.path()).await.unwrap();
        let folder = idx
            .query(
                &SourceId::Local,
                dir.path(),
                "new_needle",
                &SearchOpts::default(),
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(folder.len(), 1);
        let global = idx
            .query_global_local(dir.path(), "new_needle", &SearchOpts::default())
            .await
            .unwrap();
        assert_eq!(
            global.len(),
            1,
            "the search-visible index must reflect a completed reindex"
        );
    }
}
