//! 압축 해제 결과 이름 — `이름 (2)` 번호 붙이기와 이름 예약.
//!
//! "둘 다 유지"는 무엇도 바꾸거나 덮지 않아야 한다 — 계획 때 비어 있던 이름이 실행 전에
//! 생길 수 있으므로(TOCTOU), 실행은 이름을 검사하지 않고 `mkdir`(폴더) /
//! `create_new_file`(파일)로 **만들어 본다**. 둘 다 이미 있으면 실패하는 생성이라, 예약
//! 시점에 있던 항목을 덮는 일은 없다. 실패했는데 그 자리에 무언가 있으면 다음 번호로 간다.
//! 예약 *뒤에* 외부 프로그램이 그 자리에 쓰는 것까지 막지는 않는다 — 호출부의 몫이다.
//!
//! 이름 결합은 `fs.join` (원격 POSIX / 로컬 네이티브, CLAUDE.md §7).

use crate::fs::FileSystem;
use crate::types::DuetError;
use std::path::{Path, PathBuf};

/// `이름 (n)` 을 찾는 최대 번호.
pub(crate) const MAX_SUFFIX: u32 = 9999;

/// 무엇으로 예약하는가 — 폴더는 `mkdir`, 파일(심볼릭 링크 자리 포함)은 빈 파일.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reserve {
    Dir,
    File,
}

/// `n` 번째 이름. 폴더는 이름 끝에(`my.v1 (2)`), 파일은 확장자 앞에(`log (2).txt`)
/// 붙인다 — 파일은 확장자로 열리므로. 선두 dot(`.bashrc`)·끝 dot 은 확장자로 안 본다.
/// 길이 한계는 `suffixed_name` 이 처리.
pub(crate) fn numbered_name(name: &str, n: u32, kind: Reserve) -> String {
    if kind == Reserve::File {
        if let Some(i) = name.rfind('.') {
            if i > 0 && i < name.len() - 1 {
                let (base, ext) = name.split_at(i);
                return crate::fs::suffixed_name(base, &format!(" ({n}){ext}"));
            }
        }
    }
    crate::fs::suffixed_name(name, &format!(" ({n})"))
}

/// `path` 를 새로 만들어 예약한다. 만들었으면 `Ok(true)`, 이미 무언가 있으면 `Ok(false)`.
/// 기존 항목을 바꾸거나 덮는 일은 없다. 그 밖의 실패(권한·연결)는 에러.
///
/// 이미 있음을 따로 나타내는 에러 종류가 없어(`DuetError::Io`) 실패 후 그 자리를
/// lstat 로 확인한다 — 있으면 충돌, 없으면 진짜 실패.
pub(crate) async fn try_reserve(
    fs: &dyn FileSystem,
    path: &Path,
    kind: Reserve,
) -> Result<bool, DuetError> {
    let made = match kind {
        Reserve::Dir => fs.mkdir(path).await,
        Reserve::File => fs.create_new_file(path).await,
    };
    match made {
        Ok(()) => Ok(true),
        Err(e) => {
            if fs.symlink_metadata(path).await.is_ok() {
                Ok(false)
            } else {
                Err(e)
            }
        }
    }
}

/// `dir` 안에 `first`(있으면) → `name (2)` → `name (3)` … 순으로 처음 예약에 성공한
/// 경로와 그 이름. `first` 는 계획이 고른 이름(힌트) — 그 사이 생겼으면 다음 번호로 간다.
pub(crate) async fn reserve_free(
    fs: &dyn FileSystem,
    dir: &Path,
    name: &str,
    kind: Reserve,
    first: Option<&str>,
) -> Result<(PathBuf, String), DuetError> {
    if let Some(hint) = first {
        let path = fs.join(dir, hint);
        if try_reserve(fs, &path, kind).await? {
            return Ok((path, hint.to_string()));
        }
    }
    for n in 2..=MAX_SUFFIX {
        let cand = numbered_name(name, n, kind);
        if first == Some(cand.as_str()) {
            continue;
        }
        let path = fs.join(dir, &cand);
        if try_reserve(fs, &path, kind).await? {
            return Ok((path, cand));
        }
    }
    Err(DuetError::Io(format!(
        "no free name for {name} (tried up to ({MAX_SUFFIX}))"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::LocalFs;

    #[test]
    fn numbered_name_places_number_before_file_extension_only() {
        assert_eq!(numbered_name("a", 2, Reserve::Dir), "a (2)");
        assert_eq!(numbered_name("my.v1", 3, Reserve::Dir), "my.v1 (3)");
        assert_eq!(numbered_name("log.txt", 2, Reserve::File), "log (2).txt");
        assert_eq!(numbered_name(".bashrc", 2, Reserve::File), ".bashrc (2)");
        assert_eq!(numbered_name("noext", 2, Reserve::File), "noext (2)");
        assert_eq!(numbered_name("trail.", 2, Reserve::File), "trail. (2)");
    }

    #[tokio::test]
    async fn try_reserve_never_touches_existing_items() {
        let t = tempfile::tempdir().unwrap();
        let fs = LocalFs::new();
        std::fs::write(t.path().join("f"), b"keep").unwrap();
        std::fs::create_dir(t.path().join("d")).unwrap();
        std::fs::write(t.path().join("d").join("x"), b"x").unwrap();
        for (name, kind) in [
            ("f", Reserve::File),
            ("f", Reserve::Dir),
            ("d", Reserve::Dir),
            ("d", Reserve::File),
        ] {
            assert!(!try_reserve(&fs, &t.path().join(name), kind).await.unwrap());
        }
        assert_eq!(std::fs::read(t.path().join("f")).unwrap(), b"keep");
        assert!(t.path().join("d").join("x").exists());
        assert!(try_reserve(&fs, &t.path().join("new"), Reserve::Dir)
            .await
            .unwrap());
        assert!(t.path().join("new").is_dir());
        // 부모가 없는 진짜 실패는 충돌이 아니라 에러.
        assert!(try_reserve(&fs, &t.path().join("no/such"), Reserve::File)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn reserve_free_skips_taken_hint_and_numbers() {
        let t = tempfile::tempdir().unwrap();
        let fs = LocalFs::new();
        for n in ["a", "a (2)", "a (3)"] {
            std::fs::create_dir(t.path().join(n)).unwrap();
        }
        let (path, name) = reserve_free(&fs, t.path(), "a", Reserve::Dir, Some("a (2)"))
            .await
            .unwrap();
        assert_eq!(name, "a (4)");
        assert_eq!(path, t.path().join("a (4)"));
        assert!(path.is_dir());
    }
}
