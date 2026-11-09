//! 앱 설정·기록 파일(설정, 키맵, 북마크, journal 등)의 안전한 저장·로드 헬퍼.
//!
//! - [`write_atomic`]: 같은 폴더의 임시 파일에 쓰고 fsync 한 뒤 rename — 쓰는 도중
//!   강제 종료·전원 차단이 나도 원본은 옛 내용 그대로이거나 새 내용 전체다(잘린 파일 없음).
//! - [`load_or_quarantine`]: 파일이 깨져 있으면 원본을 `<이름>.corrupt-<시각>` 으로 옮겨
//!   **보존**하고 기본값으로 시작한다. 앱이 켜지지 않는 것보다 낫고, 원본은 사용자가 살릴 수 있다.
//! - [`backup_copy`]: 원본은 그대로 두고 `.corrupt-<시각>` 사본만 남긴다(journal 처럼 일부만 버릴 때).
//!
//! 임시 파일 이름은 대상마다 고정(`.<이름>.tmp`)이라 실패해도 쌓이지 않고 다음 저장이 덮어쓴다.
//! 그래서 **같은 경로를 동시에 쓰면 안 된다** — 호출하는 store 가 자기 잠금 안에서 부른다.
//! 이 모듈은 아무것도 지우지 않는다(CLAUDE.md §3).

use crate::types::DuetError;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

/// 깨진 파일을 옆으로 옮긴(또는 복사한) 결과 — 시작 후 사용자 알림에 쓴다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quarantined {
    /// 원래 파일 경로.
    pub original: PathBuf,
    /// 보존한 사본 경로 (`<이름>.corrupt-<시각>`).
    pub backup: PathBuf,
    /// 파싱 실패 원문(줄·열 포함). 로그·알림 "자세히"용.
    pub reason: String,
}

/// [`load_or_quarantine`] 결과.
#[derive(Debug)]
pub struct Loaded<T> {
    pub value: T,
    /// `Some` 이면 원본이 깨져 옆으로 옮기고 기본값으로 시작했다.
    pub quarantined: Option<Quarantined>,
}

/// `path` 에 `bytes` 를 원자적으로 쓴다 (같은 폴더 임시 파일 → fsync → rename).
///
/// 부모 폴더가 없으면 만든다. 같은 `path` 를 동시에 부르지 말 것(모듈 문서 참고).
pub async fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
    write_atomic_inner(path, bytes, None).await
}

/// [`write_atomic`] 과 같고, unix 에서 파일 권한을 소유자 전용(0o600)으로 만든다.
/// 권한은 rename 전 임시 파일에 걸어 넓은 권한으로 잠시도 노출되지 않게 한다.
/// (Windows 는 권한 모델이 달라 아무것도 하지 않는다.)
pub async fn write_atomic_private(path: &Path, bytes: &[u8]) -> Result<(), DuetError> {
    write_atomic_inner(path, bytes, Some(0o600)).await
}

async fn write_atomic_inner(
    path: &Path,
    bytes: &[u8],
    #[cfg_attr(not(unix), allow(unused_variables))] mode: Option<u32>,
) -> Result<(), DuetError> {
    let parent = parent_dir(path)?;
    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(DuetError::from)?;
    let tmp = tmp_path(path)?;
    {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)
            .await
            .map_err(DuetError::from)?;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(mode))
                .await
                .map_err(DuetError::from)?;
        }
        file.write_all(bytes).await.map_err(DuetError::from)?;
        file.sync_all().await.map_err(DuetError::from)?;
    }
    // Windows 의 std rename 은 MoveFileExW(MOVEFILE_REPLACE_EXISTING) — 기존 파일을 교체한다.
    tokio::fs::rename(&tmp, path)
        .await
        .map_err(DuetError::from)?;
    sync_dir(&parent).await;
    Ok(())
}

/// 파일을 읽어 `parse` 한다. 없으면 `default()`.
///
/// 파싱 실패(또는 UTF-8 아님)면 원본을 `<이름>.corrupt-<시각>` 으로 옮기고 `default()` 를
/// 돌려주며 `quarantined` 에 기록한다. 옮기기가 실패하면 복사로 보존을 시도하고, 그것도
/// 실패하면 `Err` — 원본을 보존하지 못한 채 기본값으로 시작하면 다음 저장이 원본을 덮어쓰기 때문.
/// 읽기 자체의 IO 오류(권한 등, NotFound 제외)도 `Err` 다.
pub async fn load_or_quarantine<T>(
    path: &Path,
    parse: impl FnOnce(&str) -> Result<T, String>,
    default: impl FnOnce() -> T,
) -> Result<Loaded<T>, DuetError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded {
                value: default(),
                quarantined: None,
            })
        }
        Err(e) => return Err(DuetError::from(e)),
    };
    let reason = match String::from_utf8(bytes) {
        Ok(text) => match parse(&text) {
            Ok(value) => {
                return Ok(Loaded {
                    value,
                    quarantined: None,
                })
            }
            Err(e) => e,
        },
        Err(e) => format!("not UTF-8: {e}"),
    };
    let backup = quarantine(path).await?;
    tracing::warn!(
        "corrupt file moved aside: {} -> {} ({reason})",
        path.display(),
        backup.display()
    );
    Ok(Loaded {
        value: default(),
        quarantined: Some(Quarantined {
            original: path.to_path_buf(),
            backup,
            reason,
        }),
    })
}

/// 원본은 그대로 두고 `<이름>.corrupt-<시각>` 사본을 만든다. 만든 사본 경로를 돌려준다.
pub async fn backup_copy(path: &Path) -> Result<PathBuf, DuetError> {
    let backup = corrupt_backup_path(path).await?;
    tokio::fs::copy(path, &backup)
        .await
        .map_err(DuetError::from)?;
    Ok(backup)
}

/// 원본을 `.corrupt-<시각>` 으로 rename. 실패하면 복사로 보존.
async fn quarantine(path: &Path) -> Result<PathBuf, DuetError> {
    let backup = corrupt_backup_path(path).await?;
    match tokio::fs::rename(path, &backup).await {
        Ok(()) => Ok(backup),
        Err(rename_err) => {
            tracing::warn!(
                "rename to {} failed ({rename_err}); copying instead",
                backup.display()
            );
            tokio::fs::copy(path, &backup)
                .await
                .map_err(DuetError::from)?;
            Ok(backup)
        }
    }
}

/// `<이름>.corrupt-<YYYYMMDD-HHMMSS>` — 이미 있으면 `-2`, `-3` … 을 붙인다.
async fn corrupt_backup_path(path: &Path) -> Result<PathBuf, DuetError> {
    let name = file_name(path)?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    for n in 1u32..1000 {
        let mut candidate: OsString = name.clone();
        candidate.push(".corrupt-");
        candidate.push(&stamp);
        if n > 1 {
            candidate.push(format!("-{n}"));
        }
        let p = path.with_file_name(candidate);
        match tokio::fs::symlink_metadata(&p).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(p),
            Err(e) => return Err(DuetError::from(e)),
            Ok(_) => continue,
        }
    }
    Err(DuetError::Io(format!(
        "no free backup name for {}",
        path.display()
    )))
}

/// `.<이름>.tmp` — 같은 폴더(같은 볼륨)라 rename 이 원자적이다.
fn tmp_path(path: &Path) -> Result<PathBuf, DuetError> {
    let mut tmp = OsString::from(".");
    tmp.push(file_name(path)?);
    tmp.push(".tmp");
    Ok(path.with_file_name(tmp))
}

fn file_name(path: &Path) -> Result<OsString, DuetError> {
    path.file_name()
        .map(|n| n.to_os_string())
        .ok_or_else(|| DuetError::Io(format!("no file name: {}", path.display())))
}

fn parent_dir(path: &Path) -> Result<PathBuf, DuetError> {
    match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => Ok(p.to_path_buf()),
        Some(_) => Ok(PathBuf::from(".")),
        None => Err(DuetError::Io(format!("no parent dir: {}", path.display()))),
    }
}

/// rename 을 디스크에 확정 — unix 는 폴더 fsync. 실패해도 저장 자체는 성공으로 본다(best effort).
async fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    {
        let dir = dir.to_path_buf();
        let _ = tokio::task::spawn_blocking(move || std::fs::File::open(&dir)?.sync_all()).await;
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn parse_num(s: &str) -> Result<u32, String> {
        s.trim().parse::<u32>().map_err(|e| e.to_string())
    }

    #[tokio::test]
    async fn write_atomic_creates_parent_and_replaces_existing() {
        let d = tempdir().unwrap();
        let p = d.path().join("sub").join("a.json");
        write_atomic(&p, b"one").await.unwrap();
        write_atomic(&p, b"two").await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
    }

    #[tokio::test]
    async fn write_atomic_leaves_original_when_rename_target_is_dir() {
        // 대상이 폴더면 rename 이 실패한다 — 원래 있던 것은 그대로여야 한다.
        let d = tempdir().unwrap();
        let p = d.path().join("a.json");
        std::fs::create_dir(&p).unwrap();
        assert!(write_atomic(&p, b"x").await.is_err());
        assert!(p.is_dir());
    }

    #[tokio::test]
    async fn write_atomic_fails_cleanly_when_parent_is_a_file() {
        let d = tempdir().unwrap();
        let blocker = d.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        assert!(write_atomic(&blocker.join("a.json"), b"x").await.is_err());
        assert_eq!(std::fs::read(&blocker).unwrap(), b"x");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_atomic_private_sets_owner_only_mode() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let p = d.path().join("v.age");
        write_atomic_private(&p, b"secret").await.unwrap();
        let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[tokio::test]
    async fn load_missing_file_gives_default_without_notice() {
        let d = tempdir().unwrap();
        let l = load_or_quarantine(&d.path().join("x"), parse_num, || 7)
            .await
            .unwrap();
        assert_eq!(l.value, 7);
        assert!(l.quarantined.is_none());
    }

    #[tokio::test]
    async fn load_valid_file_parses() {
        let d = tempdir().unwrap();
        let p = d.path().join("x");
        std::fs::write(&p, "42").unwrap();
        let l = load_or_quarantine(&p, parse_num, || 7).await.unwrap();
        assert_eq!(l.value, 42);
        assert!(l.quarantined.is_none());
        assert!(p.exists());
    }

    #[tokio::test]
    async fn load_corrupt_file_moves_it_aside_and_keeps_bytes() {
        let d = tempdir().unwrap();
        let p = d.path().join("x.toml");
        std::fs::write(&p, "not a number").unwrap();
        let l = load_or_quarantine(&p, parse_num, || 7).await.unwrap();
        assert_eq!(l.value, 7);
        let q = l.quarantined.expect("quarantined");
        assert_eq!(q.original, p);
        assert!(!p.exists(), "corrupt original must be moved aside");
        assert_eq!(std::fs::read(&q.backup).unwrap(), b"not a number");
        let name = q.backup.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.starts_with("x.toml.corrupt-"), "{name}");
        assert!(!q.reason.is_empty());
    }

    #[tokio::test]
    async fn load_non_utf8_is_quarantined() {
        let d = tempdir().unwrap();
        let p = d.path().join("x");
        std::fs::write(&p, [0xff, 0xfe, 0x00]).unwrap();
        let l = load_or_quarantine(&p, parse_num, || 7).await.unwrap();
        assert_eq!(l.value, 7);
        assert!(l.quarantined.is_some());
    }

    #[tokio::test]
    async fn repeated_quarantine_never_overwrites_an_earlier_backup() {
        let d = tempdir().unwrap();
        let p = d.path().join("x");
        let mut backups = Vec::new();
        for i in 0..3 {
            std::fs::write(&p, format!("bad-{i}")).unwrap();
            let l = load_or_quarantine(&p, parse_num, || 0).await.unwrap();
            backups.push(l.quarantined.unwrap().backup);
        }
        for (i, b) in backups.iter().enumerate() {
            assert_eq!(std::fs::read_to_string(b).unwrap(), format!("bad-{i}"));
        }
    }

    #[tokio::test]
    async fn backup_copy_keeps_original() {
        let d = tempdir().unwrap();
        let p = d.path().join("journal.jsonl");
        std::fs::write(&p, "a\nb").unwrap();
        let b = backup_copy(&p).await.unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"a\nb");
        assert_eq!(std::fs::read(&b).unwrap(), b"a\nb");
    }
}
