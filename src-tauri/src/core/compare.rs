//! 두 디렉토리 재귀 비교 (folder diff).
//!
//! 양쪽(좌/우 패널) 트리를 걸어 상대경로별 상태를 분류한다 — 읽기 전용, fs 변경 없음.
//! 결과는 IPC 로 노출돼 비교 다이얼로그가 보여주고, 안전한 양방향 머지의 입력이 된다.

use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, Location};
use serde::{Deserialize, Serialize};
use specta::Type;

/// 비교 항목 한 개 (상대경로 기준).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CompareEntry {
    /// 비교 루트로부터의 상대경로 (`/` 구분, 표시용).
    pub rel: String,
    pub kind: EntryKind,
    pub status: CompareStatus,
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
}

/// IPC 페이로드 폭주 방지 상한. 초과분은 `truncated=true` 로 알림(조용히 누락 금지).
const MAX_ENTRIES: usize = 5000;

/// 좌/우 디렉토리를 재귀 비교. 같은 이름이 양쪽 디렉토리면 내부로 재귀하고,
/// 한쪽에만 있는 디렉토리는 그 디렉토리 하나를 LeftOnly/RightOnly 로(머지 시 통째 복사).
pub async fn compare_dirs(
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
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
        }
    }
    Ok(ComparePlan {
        left,
        right,
        entries: out,
        left_only: counts[0],
        right_only: counts[1],
        differ: counts[2],
        same: counts[3],
        truncated,
    })
}

fn join_rel(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// 파일 둘의 상태 — 크기+mtime 일치면 Same, 아니면 mtime 으로 방향 판정.
fn classify_files(l: &Entry, r: &Entry) -> CompareStatus {
    if l.size == r.size && l.modified_ms == r.modified_ms {
        return CompareStatus::Same;
    }
    match (l.modified_ms, r.modified_ms) {
        (Some(a), Some(b)) if a > b => CompareStatus::NewerLeft,
        (Some(a), Some(b)) if b > a => CompareStatus::NewerRight,
        _ => CompareStatus::Differ,
    }
}

async fn compare_into(
    left_fs: &dyn FileSystem,
    lpath: &std::path::Path,
    right_fs: &dyn FileSystem,
    rpath: &std::path::Path,
    rel: &str,
    out: &mut Vec<CompareEntry>,
    truncated: &mut bool,
) -> Result<(), DuetError> {
    use std::collections::BTreeMap;
    let left: BTreeMap<String, Entry> = left_fs
        .list(lpath)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect();
    let right: BTreeMap<String, Entry> = right_fs
        .list(rpath)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|e| (e.name.clone(), e))
        .collect();

    // 합집합(정렬 — BTreeMap 키 순회).
    let mut names: Vec<&String> = left.keys().chain(right.keys()).collect();
    names.sort();
    names.dedup();

    for name in names {
        if out.len() >= MAX_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        let rel_name = join_rel(rel, name);
        match (left.get(name), right.get(name)) {
            (Some(l), None) => out.push(CompareEntry {
                rel: rel_name,
                kind: l.kind,
                status: CompareStatus::LeftOnly,
            }),
            (None, Some(r)) => out.push(CompareEntry {
                rel: rel_name,
                kind: r.kind,
                status: CompareStatus::RightOnly,
            }),
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
                    ))
                    .await?;
                } else if l.kind == EntryKind::File && r.kind == EntryKind::File {
                    out.push(CompareEntry {
                        rel: rel_name,
                        kind: EntryKind::File,
                        status: classify_files(l, r),
                    });
                } else {
                    // 타입 불일치(한쪽 dir, 한쪽 file 등).
                    out.push(CompareEntry {
                        rel: rel_name,
                        kind: l.kind,
                        status: CompareStatus::Differ,
                    });
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
}
