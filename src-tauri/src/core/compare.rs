//! 두 디렉토리 재귀 비교 (folder diff).
//!
//! 양쪽(좌/우 패널) 트리를 걸어 상대경로별 상태를 분류한다 — 읽기 전용, fs 변경 없음.
//! 결과는 IPC 로 노출돼 비교 다이얼로그가 보여주고, 안전한 양방향 머지의 입력이 된다.

use crate::core::copy_strategy::{decide, CopyStrategy};
use crate::core::search::nfc_key;
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

/// 여러 쪽(비교 2쪽, 3-way 3쪽) 목록을 NFC 키로 묶는다 — 같은 키 = 같은 이름(G-14/SC-17).
///
/// 어느 한쪽에라도 정규화만 다른 이름이 둘 이상 있으면(정규화를 구분하는 Linux·NTFS 에서
/// 가능) 그 키는 **모든 쪽에서** 원본 이름을 키로 쓴다 — 서로 다른 파일을 한 행으로
/// 뭉개지 않고, 반대쪽의 같은 바이트 이름과 정확히 짝지어지게.
pub(crate) fn keyed_by_nfc<const N: usize>(
    lists: [Vec<Entry>; N],
) -> [std::collections::BTreeMap<String, Entry>; N] {
    use std::collections::{HashMap, HashSet};
    let mut ambiguous: HashSet<String> = HashSet::new();
    for list in &lists {
        let mut count: HashMap<String, usize> = HashMap::new();
        for e in list {
            *count.entry(nfc_key(&e.name)).or_default() += 1;
        }
        ambiguous.extend(count.into_iter().filter(|(_, n)| *n > 1).map(|(k, _)| k));
    }
    lists.map(|list| {
        list.into_iter()
            .map(|e| {
                let key = nfc_key(&e.name);
                let key = if ambiguous.contains(&key) {
                    e.name.clone()
                } else {
                    key
                };
                (key, e)
            })
            .collect()
    })
}

/// 비교 행의 상대경로(`rel`, 한쪽 원본 이름 기준)를 `root` 쪽 **실제 이름**으로 바꾼다.
///
/// 비교는 NFC 키로 짝을 지으므로 행 이름이 반대쪽 실제 이름과 정규화 형태만 다를 수 있다.
/// 정규화를 무시하는 FS(macOS APFS)는 어느 형태든 같은 파일이지만, 구분하는 FS(Linux·NTFS)
/// 에서는 다른 형태로 열면 "없음"이거나 옆에 새 파일이 생긴다. 그래서 적용·병합이 경로를
/// 만들기 전에 이 함수를 거친다.
///
/// - 정규화 형태가 하나뿐인 이름(ASCII 등)이거나 `root/rel` 이 있으면 I/O 없이(또는 한 번만) 그대로.
/// - 아니면 조각마다: 그대로 있으면 유지, 없으면 부모 목록에서 NFC 가 같은 이름이 **하나**일 때
///   그 이름으로. 없으면 새로 만들 조각이라 이후 조각은 그대로 둔다.
/// - 목록 읽기 실패는 원래 `rel` 을 돌려준다 — 오류를 삼켜 엉뚱한 파일로 가지 않게.
pub async fn resolve_side_rel(
    fs: &dyn FileSystem,
    root: &std::path::Path,
    rel: &std::path::Path,
) -> std::path::PathBuf {
    use unicode_normalization::UnicodeNormalization;
    let rel_str = rel.to_string_lossy();
    if rel_str.nfc().eq(rel_str.nfd()) {
        return rel.to_path_buf();
    }
    let parts: Vec<&str> = rel_str.split('/').filter(|p| !p.is_empty()).collect();
    let full = parts
        .iter()
        .fold(root.to_path_buf(), |acc, p| fs.join(&acc, p));
    if fs.metadata(&full).await.is_ok() {
        return rel.to_path_buf();
    }
    let mut cur = root.to_path_buf();
    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    let mut lookup = true;
    for part in parts {
        let mut name = part.to_string();
        if lookup && fs.metadata(&fs.join(&cur, part)).await.is_err() {
            let Ok(entries) = fs.list(&cur).await else {
                return rel.to_path_buf();
            };
            let key = nfc_key(part);
            let mut found = entries.iter().filter(|e| nfc_key(&e.name) == key);
            match (found.next(), found.next()) {
                (Some(e), None) => name = e.name.clone(),
                // 없음 = 새로 만들 조각. 둘 이상 = 고를 수 없음. 둘 다 이후는 그대로.
                _ => lookup = false,
            }
        }
        cur = fs.join(&cur, &name);
        out.push(name);
    }
    std::path::PathBuf::from(out.join("/"))
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
    // 짝짓기 키는 NFC 정규화 이름(G-14/SC-17) — macOS 가 만든 NFD 한글 이름과 NFC 이름이
    // 한 행이 된다. 행 이름(rel)은 왼쪽 원본 이름(없으면 오른쪽)이고, 실제 파일 경로는 각 쪽
    // 원본 이름으로 만든다. 적용·병합은 `resolve_side_rel` 로 각 쪽 실제 이름을 되찾는다.
    let [left, right] = keyed_by_nfc([left_entries, right_entries]);

    // 합집합(정렬 — BTreeMap 키 순회).
    let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
    keys.sort();
    keys.dedup();

    for key in keys {
        let (l_entry, r_entry) = (left.get(key), right.get(key));
        let name: &str = match (l_entry, r_entry) {
            (Some(l), _) => &l.name,
            (None, Some(r)) => &r.name,
            (None, None) => unreachable!(),
        };
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
        match (l_entry, r_entry) {
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
                        // 각 fs 의 구분자 규칙으로 결합 — 원격은 POSIX. PathBuf::join 은
                        // Windows 클라이언트에서 `\` 를 섞어 SFTP list 가 깨진다(§7).
                        &left_fs.join(lpath, &l.name),
                        right_fs,
                        &right_fs.join(rpath, &r.name),
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

/// 비교 결과를 CSV 또는 JSON 텍스트로 직렬화 (리포트 export). 읽기 전용.
pub fn export_plan(plan: &ComparePlan, as_json: bool) -> Result<String, DuetError> {
    if as_json {
        return serde_json::to_string_pretty(plan)
            .map_err(|e| DuetError::Io(format!("export json: {e}")));
    }
    let mut s =
        String::from("\u{FEFF}status,rel,kind,left_size,right_size,left_mtime_ms,right_mtime_ms\n");
    let num = |v: Option<i64>| v.map(|x| x.to_string()).unwrap_or_default();
    let unum = |v: Option<u64>| v.map(|x| x.to_string()).unwrap_or_default();
    for e in &plan.entries {
        s.push_str(&format!(
            "{},{},{},{},{},{},{}\n",
            status_csv(e.status),
            csv_field(&e.rel),
            kind_csv(e.kind),
            unum(e.left_size),
            unum(e.right_size),
            num(e.left_mtime_ms),
            num(e.right_mtime_ms),
        ));
    }
    for m in &plan.moves {
        s.push_str(&format!(
            "moved,{},,,,,\n",
            csv_field(&format!("{} => {}", m.from_rel, m.to_rel))
        ));
    }
    Ok(s)
}

fn status_csv(s: CompareStatus) -> &'static str {
    match s {
        CompareStatus::LeftOnly => "left_only",
        CompareStatus::RightOnly => "right_only",
        CompareStatus::Same => "same",
        CompareStatus::NewerLeft => "newer_left",
        CompareStatus::NewerRight => "newer_right",
        CompareStatus::Differ => "differ",
        CompareStatus::Unreadable => "unreadable",
    }
}

fn kind_csv(k: EntryKind) -> &'static str {
    match k {
        EntryKind::File => "file",
        EntryKind::Dir => "dir",
        _ => "other",
    }
}

/// 수식 시작 문자를 먼저 중화한 뒤 쉼표/따옴표/개행을 CSV 규칙으로 escape한다.
fn csv_field(v: &str) -> String {
    let field = if v.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{v}")
    } else {
        v.to_string()
    };
    if field.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field
    }
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
    async fn export_plan_csv_and_json() {
        let dir = TempDir::new().unwrap();
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        std::fs::create_dir_all(&l).unwrap();
        std::fs::create_dir_all(&r).unwrap();
        std::fs::write(l.join("a.txt"), b"a").unwrap();
        let fs = LocalFs::new();
        let plan = compare_dirs(&fs, loc(&l), &fs, loc(&r)).await.unwrap();
        let csv = export_plan(&plan, false).unwrap();
        assert!(csv.starts_with("\u{FEFF}status,rel,kind,left_size"));
        assert!(csv.contains("left_only,a.txt,file"));
        let json = export_plan(&plan, true).unwrap();
        assert!(json.contains("\"entries\""));
        assert!(json.starts_with('{'));
    }

    #[test]
    fn csv_field_neutralizes_formulas_before_quoting() {
        for (input, expected) in [
            ("=SUM(A1)", "'=SUM(A1)"),
            ("+1", "'+1"),
            ("-1", "'-1"),
            ("@x", "'@x"),
            ("\tcmd", "'\tcmd"),
            ("\rcmd", "\"'\rcmd\""),
            ("=SUM(A1,B1)", "\"'=SUM(A1,B1)\""),
            ("normal.txt", "normal.txt"),
            ("한글.txt", "한글.txt"),
            ("", ""),
            ("a,b", "\"a,b\""),
            ("a\"b", "\"a\"\"b\""),
        ] {
            assert_eq!(csv_field(input), expected, "{input:?}");
        }
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
        /// 이름을 바이트 그대로 찾는다(정규화를 구분하는 Linux·NTFS 처럼). 목록 키(디렉토리)
        /// 이거나 부모 목록에 있는 이름만 존재한다.
        async fn metadata(
            &self,
            path: &std::path::Path,
        ) -> Result<crate::types::EntryMeta, DuetError> {
            let meta = |kind| crate::types::EntryMeta {
                kind,
                size: None,
                modified_ms: None,
                permissions: None,
            };
            if self.entries.contains_key(path) {
                return Ok(meta(EntryKind::Dir));
            }
            let hit = path.parent().zip(path.file_name()).and_then(|(p, n)| {
                self.entries
                    .get(p)?
                    .iter()
                    .find(|e| std::ffi::OsStr::new(&e.name) == n)
            });
            match hit {
                Some(e) => Ok(meta(e.kind)),
                None => Err(DuetError::NotFound(path.display().to_string())),
            }
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

    // ─── SC-17 / G-14: NFC·NFD 이름 짝짓기 ───────────────────────────────

    fn nfc(s: &str) -> String {
        use unicode_normalization::UnicodeNormalization;
        s.nfc().collect()
    }
    fn nfd(s: &str) -> String {
        use unicode_normalization::UnicodeNormalization;
        s.nfd().collect()
    }
    fn ent(name: &str, kind: EntryKind, size: u64, mtime: i64) -> Entry {
        Entry {
            name: name.into(),
            kind,
            size: if kind == EntryKind::File {
                Some(size)
            } else {
                None
            },
            modified_ms: Some(mtime),
            permissions: None,
            hidden: false,
        }
    }
    fn mock(dirs: Vec<(&str, Vec<Entry>)>) -> MockFs {
        MockFs {
            entries: dirs
                .into_iter()
                .map(|(p, v)| (std::path::PathBuf::from(p), v))
                .collect(),
            fail: std::collections::HashSet::new(),
        }
    }
    fn at(p: &str) -> Location {
        Location {
            source: crate::types::SourceId::Local,
            path: p.into(),
        }
    }

    /// 정규화만 다른 이름(왼쪽 NFC, 오른쪽 NFD)은 "왼쪽만/오른쪽만" 두 행이 아니라 한 행.
    #[tokio::test]
    async fn sc17_nfc_and_nfd_names_form_one_row() {
        let l = mock(vec![(
            "/L",
            vec![ent(&nfc("보고서.txt"), EntryKind::File, 1, 1)],
        )]);
        let r = mock(vec![(
            "/R",
            vec![ent(&nfd("보고서.txt"), EntryKind::File, 2, 2)],
        )]);
        let plan = compare_dirs(&l, at("/L"), &r, at("/R")).await.unwrap();
        assert_eq!(plan.entries.len(), 1, "{:?}", plan.entries);
        assert_eq!(plan.entries[0].rel, nfc("보고서.txt"));
        assert_eq!(plan.entries[0].status, CompareStatus::NewerRight);
        assert_eq!((plan.left_only, plan.right_only), (0, 0));
    }

    /// 짝지은 폴더는 각 쪽 실제 이름으로 내려가 읽는다(오른쪽을 왼쪽 이름으로 읽으면 빈 폴더).
    #[tokio::test]
    async fn sc17_paired_dirs_recurse_with_each_side_real_name() {
        let (dn, dd) = (nfc("자료"), nfd("자료"));
        let l = mock(vec![
            ("/L", vec![ent(&dn, EntryKind::Dir, 0, 1)]),
            (
                &format!("/L/{dn}"),
                vec![ent("a.txt", EntryKind::File, 1, 1)],
            ),
        ]);
        let r = mock(vec![
            ("/R", vec![ent(&dd, EntryKind::Dir, 0, 1)]),
            (
                &format!("/R/{dd}"),
                vec![ent("a.txt", EntryKind::File, 1, 1)],
            ),
        ]);
        let plan = compare_dirs(&l, at("/L"), &r, at("/R")).await.unwrap();
        assert_eq!(plan.entries.len(), 1, "{:?}", plan.entries);
        assert_eq!(plan.entries[0].rel, format!("{dn}/a.txt"));
        assert_eq!(plan.entries[0].status, CompareStatus::Same);
    }

    /// 한쪽에 정규화만 다른 두 이름이 함께 있으면(정규화 구분 FS) 서로 다른 파일 — 합치지 않는다.
    #[tokio::test]
    async fn sc17_two_forms_on_one_side_are_not_merged() {
        let l = mock(vec![(
            "/L",
            vec![
                ent(&nfc("메모"), EntryKind::File, 1, 1),
                ent(&nfd("메모"), EntryKind::File, 1, 1),
            ],
        )]);
        let r = mock(vec![("/R", vec![ent(&nfc("메모"), EntryKind::File, 1, 1)])]);
        let plan = compare_dirs(&l, at("/L"), &r, at("/R")).await.unwrap();
        let mut st: Vec<_> = plan
            .entries
            .iter()
            .map(|e| (e.rel.clone(), e.status))
            .collect();
        st.sort_by(|a, b| a.0.cmp(&b.0));
        let mut want = vec![
            (nfc("메모"), CompareStatus::Same),
            (nfd("메모"), CompareStatus::LeftOnly),
        ];
        want.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(st, want);
    }

    /// R2-2: 모호한 키(한쪽에 NFC·NFD 둘 다)는 **양쪽 모두** 원본 이름으로 짝짓는다 —
    /// 반대쪽이 NFD 하나뿐이어도 그 NFD 는 같은 바이트의 NFD 와 짝이 된다.
    #[tokio::test]
    async fn sc17_ambiguous_key_pairs_exact_names_on_both_sides() {
        let l = mock(vec![(
            "/L",
            vec![
                ent(&nfc("메모"), EntryKind::File, 10, 1),
                ent(&nfd("메모"), EntryKind::File, 20, 1),
            ],
        )]);
        let r = mock(vec![(
            "/R",
            vec![ent(&nfd("메모"), EntryKind::File, 20, 1)],
        )]);
        let plan = compare_dirs(&l, at("/L"), &r, at("/R")).await.unwrap();
        let st = |rel: &str| plan.entries.iter().find(|e| e.rel == rel).map(|e| e.status);
        assert_eq!(st(&nfd("메모")), Some(CompareStatus::Same));
        assert_eq!(st(&nfc("메모")), Some(CompareStatus::LeftOnly));
    }

    #[tokio::test]
    async fn sc17_resolve_side_rel_finds_real_names_on_sensitive_fs() {
        use std::path::{Path, PathBuf};
        let (dd, fd) = (nfd("자료"), nfd("보고서.txt"));
        let r = mock(vec![
            ("/R", vec![ent(&dd, EntryKind::Dir, 0, 1)]),
            (&format!("/R/{dd}"), vec![ent(&fd, EntryKind::File, 1, 1)]),
        ]);
        let root = Path::new("/R");
        // 있는 파일 — 각 조각을 실제(NFD) 이름으로.
        let rel = PathBuf::from(format!("{}/{}", nfc("자료"), nfc("보고서.txt")));
        assert_eq!(
            resolve_side_rel(&r, root, &rel).await,
            PathBuf::from(format!("{dd}/{fd}"))
        );
        // 새로 만들 파일 — 부모만 실제 이름, 마지막 조각은 그대로.
        let rel = PathBuf::from(format!("{}/{}", nfc("자료"), nfc("새 파일")));
        assert_eq!(
            resolve_side_rel(&r, root, &rel).await,
            PathBuf::from(format!("{dd}/{}", nfc("새 파일")))
        );
        // 이미 맞는 경로는 그대로.
        let rel = PathBuf::from(format!("{dd}/{fd}"));
        assert_eq!(resolve_side_rel(&r, root, &rel).await, rel);
    }

    /// 정규화 형태가 하나뿐인 이름은 I/O 없이 그대로, 목록 실패는 원래 rel 로(엉뚱한 파일 금지).
    #[tokio::test]
    async fn sc17_resolve_side_rel_fast_path_and_list_failure() {
        use std::path::{Path, PathBuf};
        let mut r = mock(vec![]);
        r.fail.insert(PathBuf::from("/R"));
        let rel = PathBuf::from("src/main.rs");
        assert_eq!(resolve_side_rel(&r, Path::new("/R"), &rel).await, rel);
        let rel = PathBuf::from(nfc("자료/보고서.txt"));
        assert_eq!(resolve_side_rel(&r, Path::new("/R"), &rel).await, rel);
    }
}
