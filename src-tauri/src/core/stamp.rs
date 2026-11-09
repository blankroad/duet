//! undo 안전 확인용 항목 지문(`ItemStamp`) 계산·비교.
//!
//! 복사·동기화·비교 적용·병합이 만든 항목을 Ctrl+Z 로 치울 때, 기록 때와 지금이 같아야만
//! 휴지통으로 보낸다(그 사이 사용자가 고친·추가한 내용을 지우지 않기 위해). 이 모듈은
//! 기록 시점(journal push 직전)과 undo 시점 양쪽에서 같은 방법으로 지문을 잰다.
//!
//! - 파일·링크·기타: lstat(링크를 따라가지 않음)의 종류·크기·수정시각.
//! - 폴더: 하위 트리를 재귀로 훑어 `(상대경로, 종류, 크기, 수정시각)` 줄을 정렬한 뒤 sha256.
//!   폴더 자신과 하위 폴더의 수정시각은 넣지 않는다(Finder 가 `.DS_Store` 를 만들기만 해도
//!   바뀌기 때문). `.DS_Store`·`Thumbs.db`·`desktop.ini` 는 OS 가 만드는 부산물이라 제외.
//!   하위 폴더 링크는 따라가지 않는다(링크 자체를 한 줄로 기록).

use crate::fs::FileSystem;
use crate::services::journal::{BackupRestore, ItemStamp};
use crate::types::{DuetError, EntryKind};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// OS 가 폴더를 열기만 해도 만드는 부산물 — 트리 digest 에서 제외.
const OS_LITTER: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// `path` 의 지금 지문. 폴더면 하위 트리 digest 까지 계산한다(큰 폴더는 그만큼 훑는다).
pub async fn stamp(fs: &dyn FileSystem, path: &Path) -> Result<ItemStamp, DuetError> {
    let meta = fs.symlink_metadata(path).await?;
    if meta.kind != EntryKind::Dir {
        return Ok(ItemStamp {
            kind: meta.kind,
            size: meta.size,
            modified_ms: meta.modified_ms,
            tree: None,
        });
    }
    let mut lines = Vec::new();
    collect_tree(fs, path, Path::new(""), &mut lines).await?;
    lines.sort();
    let mut hasher = Sha256::new();
    for line in &lines {
        hasher.update(line.as_bytes());
        hasher.update(b"\n");
    }
    Ok(ItemStamp {
        kind: EntryKind::Dir,
        size: None,
        modified_ms: None,
        tree: Some(hex::encode(hasher.finalize())),
    })
}

/// 지문 계산 실패를 None 으로(→ undo 때 "확인 불가"로 건너뜀). 기록을 막지 않는다.
pub async fn stamp_opt(fs: &dyn FileSystem, path: &Path) -> Option<ItemStamp> {
    match stamp(fs, path).await {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("undo stamp failed for {}: {e}", path.display());
            None
        }
    }
}

/// `paths` 각각의 지문(병렬 배열 — 길이 같음). 실패 항목은 None.
pub async fn stamp_all(fs: &dyn FileSystem, paths: &[PathBuf]) -> Vec<Option<ItemStamp>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        out.push(stamp_opt(fs, p).await);
    }
    out
}

/// 덮어쓴 자리(`original_path`)의 적용 직후 지문을 `applied` 에 채운다.
/// 원래 자리에 아무것도 없으면(예: rsync 가 지운 항목) None 으로 둔다.
pub async fn fill_applied(fs: &dyn FileSystem, backups: &mut [BackupRestore]) {
    for b in backups {
        b.applied = match fs.symlink_metadata(&b.original_path).await {
            Ok(_) => stamp_opt(fs, &b.original_path).await,
            Err(_) => None,
        };
    }
}

/// `fill_applied` 와 같되, 생성분 목록(`covered`)에 있는 자리는 건너뛴다 — 그 자리는
/// 생성분 지문이 이미 덮으므로 큰 폴더를 두 번 훑지 않는다(복사 실패로 남은 자리만 잼).
pub async fn fill_applied_uncovered(
    fs: &dyn FileSystem,
    backups: &mut [BackupRestore],
    covered: &[PathBuf],
) {
    for b in backups {
        if covered.contains(&b.original_path) {
            continue;
        }
        fill_applied(fs, std::slice::from_mut(b)).await;
    }
}

/// 기록 때 지문과 지금 지문이 같은가. 비교에 쓸 값이 없으면 false(안전 쪽).
///
/// 파일은 크기·수정시각 둘 다 있어야 한다. 링크·기타는 fs 가 크기를 주지 않을 수 있어
/// (LocalFs 는 링크 크기 None) 크기는 "같음"(둘 다 None 포함)만 보고, 수정시각은 꼭 있어야 한다.
pub fn same(recorded: &ItemStamp, now: &ItemStamp) -> bool {
    if recorded.kind != now.kind {
        return false;
    }
    let mtime_same = matches!(
        (recorded.modified_ms, now.modified_ms),
        (Some(a), Some(b)) if a == b
    );
    match recorded.kind {
        EntryKind::Dir => matches!((&recorded.tree, &now.tree), (Some(a), Some(b)) if a == b),
        EntryKind::File => {
            mtime_same && matches!((recorded.size, now.size), (Some(a), Some(b)) if a == b)
        }
        EntryKind::Symlink | EntryKind::Other => mtime_same && recorded.size == now.size,
    }
}

/// 폴더 `dir`(상대경로 `rel`) 아래를 재귀로 훑어 digest 줄을 모은다.
async fn collect_tree(
    fs: &dyn FileSystem,
    dir: &Path,
    rel: &Path,
    lines: &mut Vec<String>,
) -> Result<(), DuetError> {
    for e in fs.list(dir).await? {
        if OS_LITTER.contains(&e.name.as_str()) {
            continue;
        }
        let child = fs.join(dir, &e.name);
        let child_rel = rel.join(&e.name);
        let shown = child_rel.to_string_lossy();
        // `list` 는 링크를 따라가 대상의 종류·시각을 줄 수 있다(LocalFs) — lstat 로 다시 본다.
        let m = fs.symlink_metadata(&child).await?;
        match m.kind {
            EntryKind::Dir => {
                // 폴더 존재만 기록(수정시각 제외) 후 안으로.
                lines.push(format!("{shown}\tdir"));
                Box::pin(collect_tree(fs, &child, &child_rel, lines)).await?;
            }
            kind => lines.push(format!(
                "{shown}\t{kind:?}\t{}\t{}",
                m.size.map_or_else(|| "-".to_string(), |s| s.to_string()),
                m.modified_ms
                    .map_or_else(|| "-".to_string(), |t| t.to_string()),
            )),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;
    use std::time::{Duration, SystemTime};
    use tempfile::tempdir;

    fn set_mtime(p: &Path, ms: u64) {
        let f = std::fs::File::options().write(true).open(p).unwrap();
        f.set_modified(SystemTime::UNIX_EPOCH + Duration::from_millis(ms))
            .unwrap();
    }

    fn write_at(p: &Path, bytes: &[u8], ms: u64) {
        std::fs::write(p, bytes).unwrap();
        set_mtime(p, ms);
    }

    #[tokio::test]
    async fn file_edit_changes_stamp() {
        let t = tempdir().unwrap();
        let p = t.path().join("a.txt");
        write_at(&p, b"one", 1_700_000_000_000);
        let before = stamp(&LocalFs, &p).await.unwrap();
        assert!(same(&before, &stamp(&LocalFs, &p).await.unwrap()));
        // 같은 크기, 다른 시각 — 편집기 저장.
        write_at(&p, b"two", 1_700_000_005_000);
        assert!(!same(&before, &stamp(&LocalFs, &p).await.unwrap()));
        // 다른 크기, 같은 시각.
        write_at(&p, b"three", 1_700_000_000_000);
        assert!(!same(&before, &stamp(&LocalFs, &p).await.unwrap()));
    }

    #[tokio::test]
    async fn folder_add_and_nested_edit_change_stamp() {
        let t = tempdir().unwrap();
        let d = t.path().join("d");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        write_at(&d.join("sub/x"), b"x", 1_700_000_000_000);
        let before = stamp(&LocalFs, &d).await.unwrap();
        assert_eq!(before.kind, EntryKind::Dir);
        assert!(same(&before, &stamp(&LocalFs, &d).await.unwrap()));

        // 폴더에 파일 추가.
        write_at(&d.join("new.txt"), b"n", 1_700_000_000_000);
        assert!(!same(&before, &stamp(&LocalFs, &d).await.unwrap()));
        std::fs::remove_file(d.join("new.txt")).unwrap();
        assert!(same(&before, &stamp(&LocalFs, &d).await.unwrap()));

        // 하위 파일 수정.
        write_at(&d.join("sub/x"), b"y", 1_700_000_009_000);
        assert!(!same(&before, &stamp(&LocalFs, &d).await.unwrap()));
    }

    #[tokio::test]
    async fn os_litter_does_not_change_folder_stamp() {
        let t = tempdir().unwrap();
        let d = t.path().join("d");
        std::fs::create_dir_all(d.join("sub")).unwrap();
        write_at(&d.join("a"), b"a", 1_700_000_000_000);
        let before = stamp(&LocalFs, &d).await.unwrap();
        // Finder/Explorer 부산물은 폴더 수정시각까지 바꾸지만 같다고 본다.
        std::fs::write(d.join(".DS_Store"), b"finder").unwrap();
        std::fs::write(d.join("sub/Thumbs.db"), b"thumbs").unwrap();
        assert!(same(&before, &stamp(&LocalFs, &d).await.unwrap()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_is_stamped_as_link_not_target() {
        let t = tempdir().unwrap();
        let target = t.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = t.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let before = stamp(&LocalFs, &link).await.unwrap();
        assert_eq!(before.kind, EntryKind::Symlink);
        // 링크 대상 안을 바꿔도 링크 자체의 지문은 같다(따라가지 않음).
        std::fs::write(target.join("inside"), b"i").unwrap();
        assert!(same(&before, &stamp(&LocalFs, &link).await.unwrap()));

        // 폴더 안의 링크도 따라가지 않는다 — 대상 변경이 폴더 지문을 바꾸지 않음.
        let d = t.path().join("d");
        std::fs::create_dir(&d).unwrap();
        std::os::unix::fs::symlink(&target, d.join("l")).unwrap();
        let dir_before = stamp(&LocalFs, &d).await.unwrap();
        std::fs::write(target.join("inside2"), b"j").unwrap();
        assert!(same(&dir_before, &stamp(&LocalFs, &d).await.unwrap()));
    }

    #[test]
    fn missing_values_never_match() {
        let a = ItemStamp {
            kind: EntryKind::File,
            size: Some(1),
            modified_ms: None,
            tree: None,
        };
        assert!(!same(&a, &a.clone()));
        let d = ItemStamp {
            kind: EntryKind::Dir,
            size: None,
            modified_ms: None,
            tree: None,
        };
        assert!(!same(&d, &d.clone()));
        let f = ItemStamp {
            kind: EntryKind::File,
            size: Some(1),
            modified_ms: Some(5),
            tree: None,
        };
        let dir_with_same_numbers = ItemStamp {
            kind: EntryKind::Dir,
            ..f.clone()
        };
        assert!(!same(&f, &dir_with_same_numbers));
        // 링크: 크기 없음은 허용, 수정시각 없음은 불가.
        let link = ItemStamp {
            kind: EntryKind::Symlink,
            size: None,
            modified_ms: Some(5),
            tree: None,
        };
        assert!(same(&link, &link.clone()));
        let link_no_mtime = ItemStamp {
            modified_ms: None,
            ..link.clone()
        };
        assert!(!same(&link_no_mtime, &link_no_mtime.clone()));
    }

    #[tokio::test]
    async fn stamp_all_keeps_length_and_marks_missing() {
        let t = tempdir().unwrap();
        let a = t.path().join("a");
        std::fs::write(&a, b"a").unwrap();
        let out = stamp_all(&LocalFs, &[a, t.path().join("missing")]).await;
        assert_eq!(out.len(), 2);
        assert!(out[0].is_some() && out[1].is_none());
    }

    #[tokio::test]
    async fn fill_applied_stamps_existing_and_skips_missing() {
        let t = tempdir().unwrap();
        let here = t.path().join("here");
        std::fs::write(&here, b"h").unwrap();
        let mut b = vec![
            BackupRestore {
                backup_path: t.path().join("here.bak"),
                original_path: here,
                applied: None,
            },
            BackupRestore {
                backup_path: t.path().join("gone.bak"),
                original_path: t.path().join("gone"),
                applied: None,
            },
        ];
        fill_applied(&LocalFs, &mut b).await;
        assert!(b[0].applied.is_some());
        assert!(b[1].applied.is_none());
    }
}
