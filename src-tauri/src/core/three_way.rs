//! 3-way 비교 — 공통 조상(base) 대비 left/right 변화를 함께 보고 "추가 vs 삭제"를
//! 구별한다. 2-way 머지가 *지운 파일을 되살리는* 사고(한쪽 삭제를 '반대쪽 신규'로
//! 오인)를 막는 게 핵심. 읽기 전용 — fs 변경 없음.
//!
//! base 는 세 번째 디렉토리(원본/스냅샷). 같은 rel 에 대해 (base→left, base→right)
//! 변화를 조합해 분류한다. 내용 동등성은 size+mtime(compare 와 동일 휴리스틱).

use crate::fs::FileSystem;
use crate::types::{DuetError, Entry, EntryKind, Location};
use serde::{Deserialize, Serialize};
use specta::Type;

/// 3-way 분류 — `Unchanged` 는 entries 에 안 담김(액션 대상만).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ThreeWayStatus {
    /// 셋 다 동일 또는 left==right — 할 일 없음(목록 제외).
    Unchanged,
    /// base==right, left 만 변경 → left 채택(오른쪽으로 전파). 자동 해결 가능.
    LeftChanged,
    /// base==left, right 만 변경 → right 채택(왼쪽으로 전파). 자동 해결 가능.
    RightChanged,
    /// 양쪽 다 변경 + 서로 다름 → 충돌(사용자 해결).
    BothChanged,
    /// base 없음, left 만 추가 → 오른쪽에 추가. 자동.
    LeftAdded,
    /// base 없음, right 만 추가 → 왼쪽에 추가. 자동.
    RightAdded,
    /// base 없음, 양쪽 추가했는데 내용 다름 → 충돌.
    AddConflict,
    /// base 있음, left 삭제, right 미변경 → 오른쪽에서도 삭제(삭제 전파). 자동.
    LeftDeleted,
    /// base 있음, right 삭제, left 미변경 → 왼쪽에서도 삭제. 자동.
    RightDeleted,
    /// 한쪽 삭제, 다른쪽 변경 → 충돌(삭제할지 살릴지 사용자 결정).
    DeleteConflict,
}

impl ThreeWayStatus {
    /// 충돌(사용자 해결 필요)인가.
    pub fn is_conflict(self) -> bool {
        matches!(
            self,
            ThreeWayStatus::BothChanged
                | ThreeWayStatus::AddConflict
                | ThreeWayStatus::DeleteConflict
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ThreeWayEntry {
    pub rel: String,
    pub kind: EntryKind,
    pub status: ThreeWayStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ThreeWayPlan {
    pub base: Location,
    pub left: Location,
    pub right: Location,
    pub entries: Vec<ThreeWayEntry>,
    /// 자동 해결 가능(비충돌) 개수 / 충돌 개수 — FE 요약.
    pub auto: u32,
    pub conflicts: u32,
    pub truncated: bool,
}

const MAX_ENTRIES: usize = 5000;

/// 내용 동등성 — kind+size+mtime 일치(compare 의 Same 과 동일 휴리스틱).
fn eq(a: &Entry, b: &Entry) -> bool {
    a.kind == b.kind && a.size == b.size && a.modified_ms == b.modified_ms
}

/// 파일/leaf 한 개의 3-way 상태 — (base, left, right) 존재/내용으로 분류.
pub fn classify_three(b: Option<&Entry>, l: Option<&Entry>, r: Option<&Entry>) -> ThreeWayStatus {
    use ThreeWayStatus::*;
    match (b, l, r) {
        // base 없음 — 추가 케이스.
        (None, Some(_), None) => LeftAdded,
        (None, None, Some(_)) => RightAdded,
        (None, Some(l), Some(r)) => {
            if eq(l, r) {
                Unchanged
            } else {
                AddConflict
            }
        }
        // base 있음, 양쪽 존재 — 변경 케이스.
        (Some(bb), Some(l), Some(r)) => {
            if eq(l, r) {
                return Unchanged;
            }
            match (eq(bb, l), eq(bb, r)) {
                (true, false) => RightChanged, // left 미변경, right 변경
                (false, true) => LeftChanged,  // left 변경, right 미변경
                _ => BothChanged,              // 둘 다 변경(or 불가능한 둘 다 동일)
            }
        }
        // base 있음, 한쪽 삭제 — 삭제 vs 변경.
        (Some(bb), Some(l), None) => {
            if eq(bb, l) {
                RightDeleted // right 가 삭제, left 미변경 → 삭제 전파
            } else {
                DeleteConflict // right 삭제 + left 변경
            }
        }
        (Some(bb), None, Some(r)) => {
            if eq(bb, r) {
                LeftDeleted
            } else {
                DeleteConflict
            }
        }
        // 둘 다 없음(base 만 / 전무) — 이미 동일.
        _ => Unchanged,
    }
}

/// 3-way 재귀 비교. base/left/right 세 트리를 동시에 걸어 분류한다.
pub async fn compare_three_way(
    base_fs: &dyn FileSystem,
    base: Location,
    left_fs: &dyn FileSystem,
    left: Location,
    right_fs: &dyn FileSystem,
    right: Location,
) -> Result<ThreeWayPlan, DuetError> {
    if left_fs.metadata(&left.path).await?.kind != EntryKind::Dir
        || right_fs.metadata(&right.path).await?.kind != EntryKind::Dir
        || base_fs.metadata(&base.path).await?.kind != EntryKind::Dir
    {
        return Err(DuetError::Io(
            "three-way: all sides must be directories".into(),
        ));
    }
    let mut out = Vec::new();
    let mut truncated = false;
    walk(
        base_fs,
        &base.path,
        left_fs,
        &left.path,
        right_fs,
        &right.path,
        "",
        &mut out,
        &mut truncated,
    )
    .await?;

    let conflicts = out.iter().filter(|e| e.status.is_conflict()).count() as u32;
    let auto = out.len() as u32 - conflicts;
    Ok(ThreeWayPlan {
        base,
        left,
        right,
        entries: out,
        auto,
        conflicts,
        truncated,
    })
}

#[allow(clippy::too_many_arguments)]
async fn walk(
    base_fs: &dyn FileSystem,
    bpath: &std::path::Path,
    left_fs: &dyn FileSystem,
    lpath: &std::path::Path,
    right_fs: &dyn FileSystem,
    rpath: &std::path::Path,
    rel: &str,
    out: &mut Vec<ThreeWayEntry>,
    truncated: &mut bool,
) -> Result<(), DuetError> {
    use std::collections::BTreeMap;
    let map = |v: Vec<Entry>| -> BTreeMap<String, Entry> {
        v.into_iter().map(|e| (e.name.clone(), e)).collect()
    };
    let base = map(base_fs.list(bpath).await.unwrap_or_default());
    let left = map(left_fs.list(lpath).await.unwrap_or_default());
    let right = map(right_fs.list(rpath).await.unwrap_or_default());

    let mut names: Vec<&String> = base.keys().chain(left.keys()).chain(right.keys()).collect();
    names.sort();
    names.dedup();

    for name in names {
        if out.len() >= MAX_ENTRIES {
            *truncated = true;
            return Ok(());
        }
        let b = base.get(name);
        let l = left.get(name);
        let r = right.get(name);
        let rel_name = if rel.is_empty() {
            name.to_string()
        } else {
            format!("{rel}/{name}")
        };

        let present = [b, l, r].iter().filter(|x| x.is_some()).count();
        let all_present_dir = [b, l, r]
            .iter()
            .all(|x| x.is_none_or(|e| e.kind == EntryKind::Dir));
        if present >= 2 && all_present_dir {
            // 내용 비교를 위해 재귀(없는 쪽은 빈 목록).
            Box::pin(walk(
                base_fs,
                &bpath.join(name),
                left_fs,
                &lpath.join(name),
                right_fs,
                &rpath.join(name),
                &rel_name,
                out,
                truncated,
            ))
            .await?;
        } else {
            let status = classify_three(b, l, r);
            if status != ThreeWayStatus::Unchanged {
                let kind = l.or(r).or(b).map(|e| e.kind).unwrap_or(EntryKind::File);
                out.push(ThreeWayEntry {
                    rel: rel_name,
                    kind,
                    status,
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(size: u64, mtime: i64) -> Entry {
        Entry {
            name: "f".into(),
            kind: EntryKind::File,
            size: Some(size),
            modified_ms: Some(mtime),
            permissions: None,
            hidden: false,
        }
    }

    #[test]
    fn classify_three_cases() {
        use ThreeWayStatus::*;
        let b = file(10, 100);
        // 추가
        assert_eq!(classify_three(None, Some(&file(1, 1)), None), LeftAdded);
        assert_eq!(classify_three(None, None, Some(&file(1, 1))), RightAdded);
        assert_eq!(
            classify_three(None, Some(&file(1, 1)), Some(&file(1, 1))),
            Unchanged
        );
        assert_eq!(
            classify_three(None, Some(&file(1, 1)), Some(&file(2, 2))),
            AddConflict
        );
        // 변경 (base 대비)
        assert_eq!(
            classify_three(Some(&b), Some(&file(20, 200)), Some(&b)),
            LeftChanged
        );
        assert_eq!(
            classify_three(Some(&b), Some(&b), Some(&file(20, 200))),
            RightChanged
        );
        assert_eq!(
            classify_three(Some(&b), Some(&file(20, 200)), Some(&file(30, 300))),
            BothChanged
        );
        assert_eq!(classify_three(Some(&b), Some(&b), Some(&b)), Unchanged);
        // 삭제
        assert_eq!(classify_three(Some(&b), Some(&b), None), RightDeleted);
        assert_eq!(classify_three(Some(&b), None, Some(&b)), LeftDeleted);
        // 삭제 vs 변경 → 충돌
        assert_eq!(
            classify_three(Some(&b), Some(&file(20, 200)), None),
            DeleteConflict
        );
        assert_eq!(
            classify_three(Some(&b), None, Some(&file(20, 200))),
            DeleteConflict
        );
    }

    #[tokio::test]
    async fn compare_three_way_distinguishes_delete_from_add() {
        use crate::fs::LocalFs;
        use crate::types::SourceId;
        let dir = tempfile::TempDir::new().unwrap();
        let base = dir.path().join("B");
        let l = dir.path().join("L");
        let r = dir.path().join("R");
        for p in [&base, &l, &r] {
            std::fs::create_dir_all(p).unwrap();
        }
        // gone.txt: base 에 있고 left 가 삭제, right 는 그대로 → LeftDeleted(되살리지 않음).
        std::fs::write(base.join("gone.txt"), b"x").unwrap();
        std::fs::write(r.join("gone.txt"), b"x").unwrap();
        // new.txt: base 없음, left 만 추가 → LeftAdded.
        std::fs::write(l.join("new.txt"), b"n").unwrap();

        let fs = LocalFs::new();
        let loc = |p: &std::path::Path| Location {
            source: SourceId::Local,
            path: p.to_path_buf(),
        };
        let plan = compare_three_way(&fs, loc(&base), &fs, loc(&l), &fs, loc(&r))
            .await
            .unwrap();
        let by = |rel: &str| plan.entries.iter().find(|e| e.rel == rel).map(|e| e.status);
        assert_eq!(by("gone.txt"), Some(ThreeWayStatus::LeftDeleted));
        assert_eq!(by("new.txt"), Some(ThreeWayStatus::LeftAdded));
        assert_eq!(plan.conflicts, 0);
    }
}
