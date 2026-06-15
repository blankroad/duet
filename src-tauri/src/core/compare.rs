//! 두 디렉토리 재귀 비교 (folder diff).
//!
//! 양쪽(좌/우 패널) 트리를 걸어 상대경로별 상태를 분류한다 — 읽기 전용, fs 변경 없음.
//! 결과는 IPC 로 노출돼 비교 다이얼로그가 보여주고, 안전한 양방향 머지의 입력이 된다.

use crate::core::copy_strategy::{decide, CopyStrategy};
use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, Location};
use serde::{Deserialize, Serialize};
use specta::Type;

/// 비교 항목 한 개 (상대경로 기준).
///
/// `left_*`/`right_*` 메타는 각 쪽에 존재할 때만 `Some` — 추가 I/O 없이 `list`
/// 가 이미 가져온 `Entry` 에서 채운다(FE 가 Δ·최신쪽 표시 및 실행 전 재검증에 사용).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CompareEntry {
    /// 비교 루트로부터의 상대경로 (`/` 구분, 표시용).
    pub rel: String,
    pub kind: EntryKind,
    pub status: CompareStatus,
    /// 왼쪽 크기 (존재할 때). 디렉토리는 보통 `None`.
    pub left_size: Option<u64>,
    /// 오른쪽 크기 (존재할 때).
    pub right_size: Option<u64>,
    /// 왼쪽 수정시각 (epoch ms, 존재할 때).
    pub left_mtime_ms: Option<i64>,
    /// 오른쪽 수정시각 (epoch ms, 존재할 때).
    pub right_mtime_ms: Option<i64>,
}

impl CompareEntry {
    /// 한쪽에만 존재하는 항목 (LeftOnly/RightOnly).
    fn one_side(rel: String, e: &Entry, status: CompareStatus, left: bool) -> Self {
        let (left_size, left_mtime_ms, right_size, right_mtime_ms) = if left {
            (e.size, e.modified_ms, None, None)
        } else {
            (None, None, e.size, e.modified_ms)
        };
        Self {
            rel,
            kind: e.kind,
            status,
            left_size,
            right_size,
            left_mtime_ms,
            right_mtime_ms,
        }
    }

    /// 양쪽에 존재하는 항목 (Same/Newer*/Differ).
    fn both_sides(
        rel: String,
        kind: EntryKind,
        l: &Entry,
        r: &Entry,
        status: CompareStatus,
    ) -> Self {
        Self {
            rel,
            kind,
            status,
            left_size: l.size,
            right_size: r.size,
            left_mtime_ms: l.modified_ms,
            right_mtime_ms: r.modified_ms,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum CompareStatus {
    /// 왼쪽에만 존재 (디렉토리면 그 하위 전체).
    LeftOnly,
    /// 오른쪽에만 존재.
    RightOnly,
    /// 양쪽 동일 (크기 + mtime 일치).
    Same,
    /// 양쪽 존재, 왼쪽이 더 최신(mtime).
    NewerLeft,
    /// 양쪽 존재, 오른쪽이 더 최신.
    NewerRight,
    /// 양쪽 존재하나 크기 다르고 시각 비교 불가 / 타입 불일치 등.
    Differ,
    /// 디렉토리 나열 실패(권한 거부·연결 끊김 등) — 이 서브트리는 안전 비교 불가.
    /// **머지/prune 대상에서 강제 제외**: '빈 폴더'로 오인해 반대편을 통째 복사/
    /// 삭제하는 사고를 차단(에러를 삼키지 않고 명시 표출).
    Unreadable,
}

/// 이동/이름변경으로 인식된 쌍 — 왼쪽 `from_rel` 의 내용이 오른쪽 `to_rel` 과 동일.
/// detect_renames 시 LeftOnly+RightOnly 두 줄 대신 한 줄로 묶어 표시 + merge 중복복제 차단.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MoveInfo {
    pub from_rel: String,
    pub to_rel: String,
}

/// 비교 결과 + 카운트. `truncated` 면 항목 상한 초과로 일부만 담김.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ComparePlan {
    pub left: Location,
    pub right: Location,
    pub entries: Vec<CompareEntry>,
    pub left_only: u32,
    pub right_only: u32,
    pub differ: u32,
    pub same: u32,
    /// 항목이 상한(`MAX_ENTRIES`)을 넘어 잘렸는지 — UI 가 경고 표시.
    pub truncated: bool,
    /// 머지/싱크가 어떤 경로로 실행될지 (⚡same-host 직접 / ↔PC 경유 / 로컬).
    /// 읽기 전용 — `decide(left.source, right.source)`. FE 가 대역폭 배지로 표시.
    pub strategy: CopyStrategy,
    /// detect_renames 로 인식된 이동/이름변경 쌍 (기본 빈 Vec). 해당 항목은 entries 에서
    /// 제외되고 left_only/right_only 카운트에서도 빠진다.
    #[serde(default)]
    pub moves: Vec<MoveInfo>,
}

/// 비교 규칙 — 노이즈/오탐 제거. 기본값(빈 globs, tol 0)은 종전 동작과 동일.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct CompareRules {
    /// 무시할 glob 패턴(basename 매칭) — 예: `["node_modules", ".git", "*.log"]`.
    /// 매칭된 항목/디렉토리는 통째 제외(재귀 안 함).
    pub ignore_globs: Vec<String>,
    /// mtime 허용 오차(ms). 크기 같고 mtime 차가 이 이내면 Same — SSH↔로컬의 초/ms
    /// 반올림 오탐을 흡수. 0 이면 정확 일치만 Same.
    pub mtime_tolerance_ms: i64,
}

/// 아주 단순한 glob — `*`(0+ 임의), `?`(1개). basename(세그먼트) 매칭, 슬래시 비매칭.
/// 백트래킹 two-pointer. (`node_modules`·`.git`·`*.log` 같은 흔한 케이스 커버.)
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut star_t): (Option<usize>, usize) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            star_t = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            star_t += 1;
            ti = star_t;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// IPC 페이로드 폭주 방지 상한. 초과분은 `truncated=true` 로 알림(조용히 누락 금지).
const MAX_ENTRIES: usize = 5000;

/// 좌/우 디렉토리를 재귀 비교 (취소·진행률 없음 — 내부 호출/테스트용).
/// 같은 이름이 양쪽 디렉토리면 내부로 재귀하고, 한쪽에만 있는 디렉토리는 그 디렉토리
/// 하나를 LeftOnly/RightOnly 로(머지 시 통째 복사).
pub async fn compare_dirs(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
) -> Result<ComparePlan, DuetError> {
    compare_dirs_progress(
        left_fs,
        left,
        right_fs,
        right,
        &CompareRules::default(),
        &tokio_util::sync::CancellationToken::new(),
        &|_| {},
    )
    .await
}

/// `compare_dirs` + 규칙(CompareRules)·취소·진행률(`on_progress(scanned)`).
/// 대형/원격 트리 스캔용 — 명령 레이어가 규칙 전달 + 토큰 등록 + 이벤트 emit 에 사용.
/// `on_progress` 는 스캔 중 누적 항목 수로 자주 호출되므로 호출측에서 throttle 한다.
#[allow(clippy::too_many_arguments)]
pub async fn compare_dirs_progress(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
    rules: &CompareRules,
    cancel: &tokio_util::sync::CancellationToken,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<ComparePlan, DuetError> {
    if left_fs.metadata(&left.path).await?.kind != EntryKind::Dir
        || right_fs.metadata(&right.path).await?.kind != EntryKind::Dir
    {
        return Err(DuetError::Io(
            "compare: both sides must be directories".into(),
        ));
    }
    let mut out = Vec::new();
    let mut truncated = false;
    compare_into(
        left_fs,
        &left.path,
        right_fs,
        &right.path,
        "",
        &mut out,
        &mut truncated,
        rules,
        cancel,
        on_progress,
    )
    .await?;

    let mut counts = [0u32; 4]; // [left_only, right_only, differ, same]
    for e in &out {
        match e.status {
            CompareStatus::LeftOnly => counts[0] += 1,
            CompareStatus::RightOnly => counts[1] += 1,
            CompareStatus::NewerLeft | CompareStatus::NewerRight | CompareStatus::Differ => {
                counts[2] += 1
            }
            CompareStatus::Same => counts[3] += 1,
            // Unreadable 은 4개 요약에 안 셈 — 행으로 표출 + truncated 와 별개 경고.
            CompareStatus::Unreadable => {}
        }
    }
    let strategy = decide(&left.source, &right.source);
    Ok(ComparePlan {
        left,
        right,
        entries: out,
        left_only: counts[0],
        right_only: counts[1],
        differ: counts[2],
        same: counts[3],
        truncated,
        strategy,
        moves: Vec::new(),
    })
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// 양쪽 파일의 6-way 상태 — **표시(비교창)와 머지의 단일 판정 출처**.
///
/// 크기+mtime 일치면 `Same`, 아니면 mtime 으로 방향(NewerLeft/Right), 시각 비교가
/// 불가하면 `Differ`. `merge_bidir` 은 `compare_dirs` 결과를 그대로 입력으로 쓰므로
/// "비교창에 보이는 것 = 머지가 실행하는 것" 불변식이 구조적으로 보장된다.
///
/// 주의: sync 미러의 `ops::entry_differs` 는 *단방향 복사 필요 여부* 라는 다른 관심사
/// (크기 다르거나 src 가 더 최신이면 복사)라서 이 6-way 와 1:1 대응되지 않는다 —
/// 의도적으로 분리 유지. 향후 통합 시 sync 의 덮어쓰기 의미가 바뀌므로 별도 결정 필요.
pub(crate) fn classify_files(l: &Entry, r: &Entry, mtime_tolerance_ms: i64) -> CompareStatus {
    let mtime_close = match (l.modified_ms, r.modified_ms) {
        (Some(a), Some(b)) => (a - b).abs() <= mtime_tolerance_ms,
        (None, None) => true,
        _ => false,
    };
    if l.size == r.size && mtime_close {
        return CompareStatus::Same;
    }
    match (l.modified_ms, r.modified_ms) {
        (Some(a), Some(b)) if a > b => CompareStatus::NewerLeft,
        (Some(a), Some(b)) if b > a => CompareStatus::NewerRight,
        _ => CompareStatus::Differ,
    }
}

#[allow(clippy::too_many_arguments)]
async fn compare_into(
    left_fs: &dyn FileSystem,
    lpath: &std::path::Path,
    right_fs: &dyn FileSystem,
    rpath: &std::path::Path,
    rel: &str,
    out: &mut Vec<CompareEntry>,
    truncated: &mut bool,
    rules: &CompareRules,
    cancel: &tokio_util::sync::CancellationToken,
    on_progress: &(dyn Fn(u64) + Send + Sync),
) -> Result<(), DuetError> {
    use std::collections::BTreeMap;
    if cancel.is_cancelled() {
        return Err(DuetError::Cancelled);
    }
    // 한쪽이라도 나열 실패면 이 서브트리는 안전 비교 불가 — 에러를 삼키지(빈 폴더 위장)
    // 않고 Unreadable 한 줄로 표출 후 재귀/항목생성 중단. merge/prune 은 Unreadable 을
    // 건드리지 않으므로 반대편 통째 복사·삭제 사고가 원천 차단된다.
    let (left_entries, right_entries) =
        match (left_fs.list(lpath).await, right_fs.list(rpath).await) {
            (Ok(l), Ok(r)) => (l, r),
            _ => {
                // Unreadable 은 안전 경고라 상한이어도 행을 남긴다(미세 초과 허용) +
                // truncated 표시 — 그래야 FE 의 unreadable 배너가 사라지지 않는다.
                if out.len() >= MAX_ENTRIES {
                    *truncated = true;
                }
                out.push(CompareEntry {
                    rel: if rel.is_empty() {
                        ".".to_string()
                    } else {
                        rel.to_string()
                    },
                    kind: EntryKind::Dir,
                    status: CompareStatus::Unreadable,
                    left_size: None,
                    right_size: None,
                    left_mtime_ms: None,
                    right_mtime_ms: None,
                });
                return Ok(());
            }
        };
    let left: BTreeMap<String, Entry> = left_entries
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect();
    let right: BTreeMap<String, Entry> = right_entries
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect();

    // 합집합(정렬 — BTreeMap 키 순회).
    let mut names: Vec<&String> = left.keys().chain(right.keys()).collect();
    names.sort();
    names.dedup();

    for name in names {
        if cancel.is_cancelled() {
            return Err(DuetError::Cancelled);
        }
        // ignore glob 매칭 항목은 통째 제외(디렉토리면 재귀 안 함).
        if rules.ignore_globs.iter().any(|g| glob_match(g, name)) {
            continue;
        }
        if out.len() >= MAX_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        on_progress(out.len() as u64);
        let rel_name = join_rel(rel, name);
        match (left.get(name), right.get(name)) {
            (Some(l), None) => out.push(CompareEntry::one_side(
                rel_name,
                l,
                CompareStatus::LeftOnly,
                true,
            )),
            (None, Some(r)) => out.push(CompareEntry::one_side(
                rel_name,
                r,
                CompareStatus::RightOnly,
                false,
            )),
            (Some(l), Some(r)) => {
                if l.kind == EntryKind::Dir && r.kind == EntryKind::Dir {
                    // 양쪽 디렉토리 — 내부로 재귀(디렉토리 자체는 항목으로 안 냄).
                    Box::pin(compare_into(
                        left_fs,
                        &lpath.join(name),
                        right_fs,
                        &rpath.join(name),
                        &rel_name,
                        out,
                        truncated,
                        rules,
                        cancel,
                        on_progress,
                    ))
                    .await?;
                } else if l.kind == EntryKind::File && r.kind == EntryKind::File {
                    out.push(CompareEntry::both_sides(
                        rel_name,
                        EntryKind::File,
                        l,
                        r,
                        classify_files(l, r, rules.mtime_tolerance_ms),
                    ));
                } else {
                    // 타입 불일치(한쪽 dir, 한쪽 file 등).
                    out.push(CompareEntry::both_sides(
                        rel_name,
                        l.kind,
                        l,
                        r,
                        CompareStatus::Differ,
                    ));
                }
            }
            (None, None) => unreachable!(),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use tempfile::TempDir;

    fn loc(p: &std::path::Path) -> Location {
        Location {
            source: crate::types::SourceId::Local,
            path: p.to_path_buf(),
        }
    }

    #[tokio::test]
    async fn compare_classifies_recursively() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(l.join("sub")).unwrap();
        std::fs::create_dir_all(r.join("sub")).unwrap();
        // 동일 파일.
        std::fs::write(l.join("same.txt"), b"x").unwrap();
        std::fs::write(r.join("same.txt"), b"x").unwrap();
        // 좌측만.
        std::fs::write(l.join("only_left.txt"), b"a").unwrap();
        // 우측만 (하위 디렉토리).
        std::fs::create_dir_all(r.join("ronly_dir")).unwrap();
        std::fs::write(r.join("ronly_dir/z"), b"z").unwrap();
        // 중첩: 크기 다른 파일.
        std::fs::write(l.join("sub/diff.txt"), b"aaaa").unwrap();
        std::fs::write(r.join("sub/diff.txt"), b"bb").unwrap();

        let fs = LocalFs::new();
        let plan = compare_dirs(&fs, loc(&l), &fs, loc(&r)).await.unwrap();

        let by_rel = |rel: &str| plan.entries.iter().find(|e| e.rel == rel).map(|e| e.status);
        assert_eq!(by_rel("only_left.txt"), Some(CompareStatus::LeftOnly));
        assert_eq!(by_rel("ronly_dir"), Some(CompareStatus::RightOnly));
        assert!(matches!(
            by_rel("sub/diff.txt"),
            Some(CompareStatus::NewerLeft | CompareStatus::NewerRight | CompareStatus::Differ)
        ));
        assert_eq!(plan.left_only, 1);
        assert_eq!(plan.right_only, 1);
        assert!(!plan.truncated);
    }

    #[tokio::test]
    async fn compare_rejects_non_dir() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("f"), b"x").unwrap();
        let fs = LocalFs::new();
        let r = compare_dirs(&fs, loc(&dir.path().join("f")), &fs, loc(dir.path())).await;
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn compare_cancelled_token_aborts() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("a.txt"), b"a").unwrap();
        let fs = LocalFs::new();
        let cancel = tokio_util::sync::CancellationToken::new();
        cancel.cancel(); // 미리 취소
        let res = compare_dirs_progress(
            &fs,
            loc(&l),
            &fs,
            loc(&r),
            &CompareRules::default(),
            &cancel,
            &|_| {},
        )
        .await;
        assert!(matches!(res, Err(DuetError::Cancelled)));
    }

    #[tokio::test]
    async fn compare_emits_progress() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        for n in 0..5 {
            std::fs::write(l.join(format!("f{n}")), b"x").unwrap();
        }
        let fs = LocalFs::new();
        let count = std::sync::atomic::AtomicU64::new(0);
        let cancel = tokio_util::sync::CancellationToken::new();
        compare_dirs_progress(
            &fs,
            loc(&l),
            &fs,
            loc(&r),
            &CompareRules::default(),
            &cancel,
            &|_| {
                count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            },
        )
        .await
        .unwrap();
        assert!(count.load(std::sync::atomic::Ordering::Relaxed) > 0);
    }

    #[test]
    fn classify_files_boundaries() {
        let e = |size: Option<u64>, mtime: Option<i64>| Entry {
            name: "f".into(),
            kind: EntryKind::File,
            size,
            modified_ms: mtime,
            permissions: None,
            hidden: false,
        };
        // 크기+mtime 동일 → Same.
        assert_eq!(
            classify_files(&e(Some(10), Some(5)), &e(Some(10), Some(5)), 0),
            CompareStatus::Same
        );
        // 왼쪽이 더 최신.
        assert_eq!(
            classify_files(&e(Some(10), Some(9)), &e(Some(10), Some(5)), 0),
            CompareStatus::NewerLeft
        );
        // 오른쪽이 더 최신.
        assert_eq!(
            classify_files(&e(Some(10), Some(5)), &e(Some(10), Some(9)), 0),
            CompareStatus::NewerRight
        );
        // 크기 다르고 mtime 같음 → 방향 불가 → Differ.
        assert_eq!(
            classify_files(&e(Some(10), Some(5)), &e(Some(20), Some(5)), 0),
            CompareStatus::Differ
        );
        // mtime 둘 다 없음 → Differ.
        assert_eq!(
            classify_files(&e(Some(10), None), &e(Some(20), None), 0),
            CompareStatus::Differ
        );
        // tolerance 안 mtime 차 + 같은 크기 → Same (SSH↔로컬 오탐 흡수).
        assert_eq!(
            classify_files(&e(Some(10), Some(1500)), &e(Some(10), Some(1000)), 2000),
            CompareStatus::Same
        );
        // tolerance 밖 → NewerLeft.
        assert_eq!(
            classify_files(&e(Some(10), Some(5000)), &e(Some(10), Some(1000)), 2000),
            CompareStatus::NewerLeft
        );
    }

    #[test]
    fn glob_match_basics() {
        assert!(glob_match("node_modules", "node_modules"));
        assert!(glob_match("*.log", "server.log"));
        assert!(glob_match("*.log", ".log"));
        assert!(!glob_match("*.log", "log.txt"));
        assert!(glob_match("a?c", "abc"));
        assert!(!glob_match("a?c", "ac"));
        assert!(glob_match("*", "anything"));
        assert!(!glob_match("node_modules", "node_modules2"));
    }

    #[tokio::test]
    async fn ignore_globs_exclude_subtrees() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(l.join("node_modules")).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("node_modules/x.js"), b"x").unwrap(); // 무시
        std::fs::write(l.join("keep.txt"), b"k").unwrap(); // 유지
        std::fs::write(l.join("debug.log"), b"d").unwrap(); // *.log 무시

        let fs = LocalFs::new();
        let rules = CompareRules {
            ignore_globs: vec!["node_modules".into(), "*.log".into()],
            mtime_tolerance_ms: 0,
        };
        let plan = compare_dirs_progress(
            &fs,
            loc(&l),
            &fs,
            loc(&r),
            &rules,
            &tokio_util::sync::CancellationToken::new(),
            &|_| {},
        )
        .await
        .unwrap();
        assert!(plan.entries.iter().any(|e| e.rel == "keep.txt"));
        assert!(!plan.entries.iter().any(|e| e.rel.contains("node_modules")));
        assert!(!plan.entries.iter().any(|e| e.rel == "debug.log"));
    }

    // 나열 실패를 주입하는 최소 mock — compare 가 호출하는 list/metadata 만 구현.
    struct MockFs {
        entries: std::collections::HashMap<std::path::PathBuf, Vec<Entry>>,
        fail: std::collections::HashSet<std::path::PathBuf>,
    }
    #[async_trait::async_trait]
    impl FileSystem for MockFs {
        fn source_id(&self) -> crate::types::SourceId {
            crate::types::SourceId::Local
        }
        async fn list(&self, path: &std::path::Path) -> Result<Vec<Entry>, DuetError> {
            if self.fail.contains(path) {
                return Err(DuetError::Io("permission denied (mock)".into()));
            }
            Ok(self.entries.get(path).cloned().unwrap_or_default())
        }
        async fn metadata(
            &self,
            _path: &std::path::Path,
        ) -> Result<crate::types::EntryMeta, DuetError> {
            Ok(crate::types::EntryMeta {
                kind: EntryKind::Dir,
                size: None,
                modified_ms: None,
                permissions: None,
            })
        }
        async fn rename(&self, _: &std::path::Path, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn mkdir(&self, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn trash(
            &self,
            _: &std::path::Path,
            _: &str,
        ) -> Result<crate::types::TrashLocation, DuetError> {
            unimplemented!()
        }
        async fn remove(&self, _: &std::path::Path) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn restore_from_trash(
            &self,
            _: &crate::types::TrashLocation,
            _: &std::path::Path,
        ) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn read_full(&self, _: &std::path::Path) -> Result<Vec<u8>, DuetError> {
            unimplemented!()
        }
        async fn write_full(&self, _: &std::path::Path, _: &[u8]) -> Result<(), DuetError> {
            unimplemented!()
        }
        async fn open_read(
            &self,
            _: &std::path::Path,
            _: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
            unimplemented!()
        }
        async fn open_write(
            &self,
            _: &std::path::Path,
            _: u64,
        ) -> Result<std::pin::Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
            unimplemented!()
        }
    }

    /// 한쪽 서브디렉토리 나열이 실패하면 그 서브트리는 Unreadable 한 줄로만 나오고,
    /// 반대편 내용이 RightOnly 로 새지 않아야 한다(= 머지 오복사 차단의 핵심).
    #[tokio::test]
    async fn list_failure_becomes_unreadable_not_right_only() {
        use std::collections::{HashMap, HashSet};
        let dir = |name: &str| Entry {
            name: name.into(),
            kind: EntryKind::Dir,
            size: None,
            modified_ms: None,
            permissions: None,
            hidden: false,
        };
        let file = |name: &str| Entry {
            name: name.into(),
            kind: EntryKind::File,
            size: Some(1),
            modified_ms: Some(1),
            permissions: None,
            hidden: false,
        };
        // 양쪽 루트에 "sub" 디렉토리. 왼쪽 sub 나열은 실패, 오른쪽 sub 엔 x 파일.
        let mut lmap = HashMap::new();
        lmap.insert(std::path::PathBuf::from("/L"), vec![dir("sub")]);
        let left_fs = MockFs {
            entries: lmap,
            fail: HashSet::from([std::path::PathBuf::from("/L/sub")]),
        };
        let mut rmap = HashMap::new();
        rmap.insert(std::path::PathBuf::from("/R"), vec![dir("sub")]);
        rmap.insert(std::path::PathBuf::from("/R/sub"), vec![file("x")]);
        let right_fs = MockFs {
            entries: rmap,
            fail: HashSet::new(),
        };

        let plan = compare_dirs(
            &left_fs,
            Location {
                source: crate::types::SourceId::Local,
                path: "/L".into(),
            },
            &right_fs,
            Location {
                source: crate::types::SourceId::Local,
                path: "/R".into(),
            },
        )
        .await
        .unwrap();

        // sub 는 Unreadable 한 줄.
        let sub = plan.entries.iter().find(|e| e.rel == "sub");
        assert_eq!(sub.map(|e| e.status), Some(CompareStatus::Unreadable));
        // sub/x 가 RightOnly 로 새지 않아야 함(나열 실패를 빈 폴더로 오인 금지).
        assert!(plan.entries.iter().all(|e| e.rel != "sub/x"));
        assert_eq!(plan.right_only, 0);
    }
}
