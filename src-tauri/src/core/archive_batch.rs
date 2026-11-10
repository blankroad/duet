//! 여러 아카이브를 "각각 자기 폴더로" 푸는 일괄 해제 계획.
//!
//! 해제 자체는 아카이브마다 기존 `archive::extract_execute` 를 따로 실행한다(작업 하나 =
//! journal 항목 하나 = Ctrl+Z 한 번, CLAUDE.md §4). 여기서는 실행 전에 받을 이름만
//! 정한다 — 같은 일괄 안의 두 아카이브가 같은 이름(`a.zip` + `a.tar.gz` → `a`)을 받아
//! 한쪽이 다른 쪽 결과를 백업으로 밀어내거나 덮지 않게, 이름은 선택 순서대로 배정하고
//! 뒤에 온 중복에는 `a (2)` 처럼 빈 이름을 준다.
//!
//! 디스크에 이미 있는 이름(`a/`)은 `keep_both` 로 갈린다:
//! - `false` (교체): 그 이름을 그대로 쓰고 `conflict = true` — 실행이 기존 것을 `.bak`
//!   으로 옮기고 Ctrl+Z 로 복원(기존 규칙 그대로). 사용자가 다이얼로그에서 본 이 항목만.
//! - `true` (둘 다 유지): 첫 빈 `a (2)`, `a (3)` … 를 힌트로 준다.
//!
//! 충돌로 표시되지 않은 항목은 모두 `ExtractPlan::keep_both = true` — 실행이 이름을
//! 원자적으로 예약하므로 계획 뒤에 생긴 항목(TOCTOU)도 백업하거나 덮지 않는다.
//!
//! 이름 비교는 대소문자를 무시한다 — 대소문자 구분 없는 볼륨(macOS·Windows 기본)에서
//! `A.zip` 과 `a.tar.gz` 의 결과가 같은 폴더가 되는 것을 막는다. 구분하는 볼륨에선
//! 쓸데없이 `(2)` 가 붙을 뿐 아무것도 잃지 않는다.

use crate::core::archive::{self, ExtractPlan};
use crate::core::archive_names::{numbered_name, Reserve, MAX_SUFFIX};
use crate::fs::FileSystem;
use crate::types::{DuetError, EntryRef};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// 일괄 해제 계획의 한 항목 — 하나가 실패해도 나머지는 계획된다.
/// `plan` 과 `error` 중 정확히 하나가 채워진다.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExtractPlanItem {
    /// 요청한 아카이브 (선택 순서 그대로).
    pub archive: EntryRef,
    pub plan: Option<ExtractPlan>,
    pub error: Option<DuetError>,
}

/// 같은 fs 위의 아카이브들을 선택 순서대로 계획한다. `fs` 와 source 가 다른 항목은
/// 그 항목만 에러로 둔다.
pub async fn extract_plan_batch(
    fs: &dyn FileSystem,
    archives: Vec<EntryRef>,
    keep_both: bool,
) -> Vec<ExtractPlanItem> {
    let source = fs.source_id();
    // (폴더, 소문자 이름) — 이 일괄에서 이미 배정한 받는 이름.
    let mut claimed: HashSet<(PathBuf, String)> = HashSet::new();
    let mut out = Vec::with_capacity(archives.len());
    for archive in archives {
        let result = if archive.location.source != source {
            Err(DuetError::Io(format!(
                "{}: not on the same location as the other archives",
                archive.name
            )))
        } else {
            plan_one(fs, &archive, keep_both, &mut claimed).await
        };
        out.push(match result {
            Ok(plan) => ExtractPlanItem {
                archive,
                plan: Some(plan),
                error: None,
            },
            Err(e) => ExtractPlanItem {
                archive,
                plan: None,
                error: Some(e),
            },
        });
    }
    out
}

async fn plan_one(
    fs: &dyn FileSystem,
    archive: &EntryRef,
    keep_both: bool,
    claimed: &mut HashSet<(PathBuf, String)>,
) -> Result<ExtractPlan, DuetError> {
    let format = archive::check_extractable(fs, archive).await?;
    let kind = if archive::extracts_to_single_file(format) {
        Reserve::File
    } else {
        Reserve::Dir
    };
    let dir = archive.location.path.as_path();
    let stem = archive::archive_stem(&archive.name);

    let base = fs.join(dir, &stem);
    let base_exists = exists(fs, &base).await;
    let base_free_in_batch = !claimed.contains(&claim_key(dir, &stem));
    // 이름을 그대로 쓰는 경우: 이 일괄에서 처음 나왔고, (교체 선택이거나 디스크에 없음).
    let (name, dest_dir, conflict) = if base_free_in_batch && (!keep_both || !base_exists) {
        (stem, base, base_exists)
    } else {
        let (name, path) = free_numbered(fs, dir, &stem, kind, claimed).await?;
        (name, path, false)
    };
    claimed.insert(claim_key(dir, &name));

    Ok(ExtractPlan {
        source: archive.location.source.clone(),
        archive_dir: archive.location.clone(),
        archive_name: archive.name.clone(),
        format,
        dest_dir,
        conflict,
        // 사용자가 교체를 고른 충돌 항목만 기존 규칙(백업). 나머지는 실행 때 원자적 예약.
        keep_both: !conflict,
    })
}

/// `stem (2)`, `stem (3)` … 중 디스크에도 이 일괄에도 없는 첫 이름 (실행 때의 힌트).
async fn free_numbered(
    fs: &dyn FileSystem,
    dir: &Path,
    stem: &str,
    kind: Reserve,
    claimed: &HashSet<(PathBuf, String)>,
) -> Result<(String, PathBuf), DuetError> {
    for n in 2..=MAX_SUFFIX {
        let name = numbered_name(stem, n, kind);
        if claimed.contains(&claim_key(dir, &name)) {
            continue;
        }
        let path = fs.join(dir, &name);
        if !exists(fs, &path).await {
            return Ok((name, path));
        }
    }
    Err(DuetError::Io(format!(
        "no free name for {stem} (tried up to ({MAX_SUFFIX}))"
    )))
}

fn claim_key(dir: &Path, name: &str) -> (PathBuf, String) {
    (dir.to_path_buf(), name.to_lowercase())
}

async fn exists(fs: &dyn FileSystem, path: &Path) -> bool {
    fs.metadata(path).await.is_ok()
}

#[cfg(test)]
#[path = "archive_batch_tests.rs"]
mod tests;
