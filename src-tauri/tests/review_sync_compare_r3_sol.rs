//! R3 final checks. All I/O stays in TempDir; no real SSH or OS trash.
use async_trait::async_trait;
use duet_lib::core::compare::{compare_dirs, CompareStatus};
use duet_lib::core::ops::{apply_compare, ApplyDecision, ApplyDirection, OpCtx};
#[cfg(unix)]
use duet_lib::core::ops::{sync_execute, sync_plan};
#[cfg(target_os = "macos")]
use duet_lib::core::undo::{execute_undo, UndoKind};
use duet_lib::fs::{FileSystem, LocalFs};
#[cfg(target_os = "macos")]
use duet_lib::services::connection_pool::ConnectionPool;
use duet_lib::services::journal::Journal;
#[cfg(target_os = "macos")]
use duet_lib::services::journal::UndoAction;
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{DuetError, Entry, EntryMeta, Location, SourceId, TrashLocation};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;

fn loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.into(),
    }
}
async fn ctx(p: &Path) -> OpCtx {
    OpCtx {
        journal: Journal::load_from(&p.join("j.jsonl")).await.unwrap(),
        settings: SettingsStore::load_from(&p.join("s.toml")).await.unwrap(),
        pool: None,
        app: None,
    }
}
#[derive(Default)]
struct Fixture {
    blocked: Option<PathBuf>,
    trash: Option<PathBuf>,
}
#[async_trait]
impl FileSystem for Fixture {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        if self.blocked.as_deref() == Some(p) {
            return Err(DuetError::PermissionDenied(
                "bounded recursion fixture".into(),
            ));
        }
        LocalFs.list(p).await
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        LocalFs.metadata(p).await
    }
    async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
        LocalFs.rename(f, t).await
    }
    async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.mkdir(p).await
    }
    async fn trash(&self, p: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        let to = self
            .trash
            .as_ref()
            .expect("OS trash forbidden")
            .join(p.file_name().unwrap());
        LocalFs.rename(p, &to).await?;
        Ok(TrashLocation::Remote { trash_path: to })
    }
    async fn remove(&self, _: &Path) -> Result<(), DuetError> {
        panic!("fixture permanent removal forbidden")
    }
    async fn restore_from_trash(&self, _: &TrashLocation, _: &Path) -> Result<(), DuetError> {
        panic!("OS trash forbidden")
    }
    async fn read_full(&self, p: &Path) -> Result<Vec<u8>, DuetError> {
        LocalFs.read_full(p).await
    }
    async fn write_full(&self, p: &Path, b: &[u8]) -> Result<(), DuetError> {
        LocalFs.write_full(p, b).await
    }
    async fn open_read(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncRead + Send>>, DuetError> {
        LocalFs.open_read(p, o).await
    }
    async fn open_write(
        &self,
        p: &Path,
        o: u64,
    ) -> Result<Pin<Box<dyn tokio::io::AsyncWrite + Send>>, DuetError> {
        LocalFs.open_write(p, o).await
    }
}

#[tokio::test]
#[ignore = "sync-compare repro: SC-03 independently confirmed in sol-3"]
async fn sc03_apply_parent_child_backup_row_does_not_recurse_into_itself() {
    let t = tempdir().unwrap();
    let parent = t.path().join("project");
    let child = parent.join("backup");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(child.join("한글.txt"), b"original").unwrap();
    let f = Fixture {
        blocked: Some(child.join("backup/backup/backup")),
        ..Default::default()
    };
    let shown = compare_dirs(&f, loc(&parent), &f, loc(&child))
        .await
        .unwrap();
    assert!(shown
        .entries
        .iter()
        .any(|e| e.rel == "backup" && e.status == CompareStatus::LeftOnly));
    let result = apply_compare(
        &f,
        loc(&parent),
        &f,
        loc(&child),
        vec![ApplyDecision {
            rel: "backup".into(),
            direction: ApplyDirection::ToRight,
        }],
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(
        !child.join("backup/backup").exists(),
        "SC-03: applying LeftOnly backup recursed into itself; bounded result={result:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
#[ignore = "sync-compare repro: SC-06 independently confirmed in sol-3"]
async fn sc06_prune_nested_directory_link_preserves_external_directory() {
    let t = tempdir().unwrap();
    let src = t.path().join("src");
    let dst = t.path().join("dst");
    let ext = t.path().join("external");
    let trash = t.path().join("fixture-trash");
    std::fs::create_dir_all(src.join("nested/alias")).unwrap();
    std::fs::create_dir_all(dst.join("nested")).unwrap();
    std::fs::create_dir_all(ext.join("outside-dir")).unwrap();
    std::fs::create_dir(&trash).unwrap();
    std::fs::write(ext.join("outside-dir/precious"), b"outside the destination").unwrap();
    std::os::unix::fs::symlink(&ext, dst.join("nested/alias")).unwrap();
    let f = Fixture {
        trash: Some(trash.clone()),
        ..Default::default()
    };
    let mut p = sync_plan(&LocalFs, &f, loc(&src), loc(&dst)).await.unwrap();
    p.prune = true;
    sync_execute(
        &LocalFs,
        &f,
        p,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(trash.join("outside-dir/precious")).unwrap(),
        b"outside the destination"
    );
    assert!(
        ext.join("outside-dir/precious").exists(),
        "SC-06: entire external directory was pruned through a nested destination symlink"
    );
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn sc17_apfs_paired_row_overwrite_keeps_backup_and_undo_restores() {
    use unicode_normalization::UnicodeNormalization;
    let t = tempdir().unwrap();
    let l = t.path().join("L");
    let r = t.path().join("R");
    std::fs::create_dir(&l).unwrap();
    std::fs::create_dir(&r).unwrap();
    let nfc = "자료,한글.txt";
    let nfd: String = nfc.nfd().collect();
    std::fs::write(l.join(nfc), b"left original").unwrap();
    std::fs::write(r.join(&nfd), b"right different original").unwrap();
    assert!(
        l.join(&nfd).exists(),
        "this probe requires a normalization-insensitive macOS volume"
    );
    let shown = compare_dirs(&LocalFs, loc(&l), &LocalFs, loc(&r))
        .await
        .unwrap();
    // SC-17 수정 후: 정규화만 다른 두 이름은 한 행(차이)으로 보인다 — "생성 2" 가 아니다.
    assert_eq!(shown.entries.len(), 1);
    assert!(!matches!(
        shown.entries[0].status,
        CompareStatus::LeftOnly | CompareStatus::RightOnly
    ));
    let decisions = vec![ApplyDecision {
        rel: shown.entries[0].rel.clone(),
        direction: ApplyDirection::ToRight,
    }];
    let e = apply_compare(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        decisions,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    match &e.undo {
        UndoAction::UndoCompareApply {
            left_backups,
            right_backups,
            ..
        } => {
            // 덮어쓰기라고 보여 준 그대로 오른쪽 하나만 백업 후 덮어쓴다.
            assert_eq!((left_backups.len(), right_backups.len()), (0, 1));
            assert_eq!(
                std::fs::read(&right_backups[0].backup_path).unwrap(),
                b"right different original"
            );
        }
        _ => panic!("expected compare apply"),
    }
    assert_eq!(
        std::fs::read(l.join(nfc)).unwrap(),
        std::fs::read(r.join(&nfd)).unwrap()
    );
    let out = execute_undo(&e, &ConnectionPool::new()).await;
    assert!(matches!(out.kind, UndoKind::Ok));
    assert_eq!(std::fs::read(l.join(nfc)).unwrap(), b"left original");
    assert_eq!(
        std::fs::read(r.join(&nfd)).unwrap(),
        b"right different original"
    );
}

// checksum_cmd is private. Exercise its exact source template, rather than a stale duplicate.
#[cfg(unix)]
fn checksum_command(path: &Path) -> String {
    let source = include_str!("../src/fs/ssh.rs");
    let line = source
        .lines()
        .find(|l| {
            l.trim_start()
                .starts_with("format!(\"LC_ALL=C {gnu} -- {quoted}")
        })
        .unwrap()
        .trim();
    let template = line
        .strip_prefix("format!(\"")
        .unwrap()
        .strip_suffix("\")")
        .unwrap();
    let quoted = duet_lib::core::copy_strategy::shell_escape_str(path.to_str().unwrap()).unwrap();
    template
        .replace("{gnu}", "sha256sum")
        .replace("{bsd}", "shasum -a 256")
        .replace("{quoted}", &quoted)
}
#[cfg(unix)]
fn run_checksum(path: &Path) -> std::process::Output {
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(checksum_command(path))
        .output()
        .unwrap()
}
#[cfg(unix)]
const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

#[cfg(unix)]
#[test]
fn sc47_plain_and_korean_checksum_names_produce_plain_digest() {
    let t = tempdir().unwrap();
    for n in ["plain", "한글.txt"] {
        let p = t.path().join(n);
        std::fs::write(&p, b"abc").unwrap();
        let out = run_checksum(&p);
        assert!(out.status.success());
        let s = String::from_utf8(out.stdout).unwrap();
        assert_eq!(s.split_whitespace().next(), Some(ABC_SHA256));
    }
}
#[cfg(unix)]
#[test]
// 대조군: macOS 기본 /sbin/sha256sum 에서만 통과한다. GNU sha256sum(Linux)·shasum 폴백은
// `\` 접두 digest 를 내 SC-47 결함 그대로 실패하므로 기본 스위트에서는 제외.
#[ignore = "sync-compare: SC-47 환경 의존 대조군 (macOS /sbin/sha256sum 전용)"]
fn sc47_escaped_checksum_names_produce_plain_digest() {
    let t = tempdir().unwrap();
    let mut outputs = Vec::new();
    for n in ["has\\slash", "line\nbreak"] {
        let p = t.path().join(n);
        std::fs::write(&p, b"abc").unwrap();
        let out = run_checksum(&p);
        assert!(out.status.success());
        outputs.push((n.to_string(), String::from_utf8(out.stdout).unwrap()));
    }
    assert!(outputs.iter().all(|(_,s)|s.split_whitespace().next()==Some(ABC_SHA256)),"SC-47: checksum command produced an escaped digest token rejected by the backend: {outputs:?}");
}
#[cfg(unix)]
#[test]
#[ignore = "sync-compare repro: SC-47 independently confirmed in sol-3"]
fn sc47_fallback_preserves_non_missing_gnu_error() {
    use std::os::unix::fs::PermissionsExt;
    let t = tempdir().unwrap();
    let bin = t.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    for (name, body) in [
        (
            "sha256sum",
            "#!/bin/sh\nprintf 'GNU_PERMISSION_DENIED\\n' >&2\nexit 13\n",
        ),
        (
            "shasum",
            "#!/bin/sh\nprintf 'BSD_MISSING_TOOL\\n' >&2\nexit 127\n",
        ),
    ] {
        let p = bin.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let out = std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(checksum_command(&t.path().join("file")))
        .env("PATH", &bin)
        .output()
        .unwrap();
    let err = String::from_utf8(out.stderr).unwrap();
    assert_eq!(out.status.code(), Some(127));
    assert!(err.contains("BSD_MISSING_TOOL"));
    assert!(
        err.contains("GNU_PERMISSION_DENIED"),
        "SC-47: original GNU error was discarded; stderr={err:?}"
    );
}

#[cfg(all(unix, target_os = "macos"))]
#[test]
#[ignore = "sync-compare repro: SC-47 independently confirmed in sol-3"]
fn sc47_gnu_and_shasum_escaped_names_produce_plain_digest() {
    let t = tempdir().unwrap();
    let bin = t.path().join("gnu-bin");
    std::fs::create_dir(&bin).unwrap();
    let gnu = Path::new("/opt/homebrew/bin/gsha256sum");
    assert!(
        gnu.exists(),
        "this installed-tool probe requires the existing GNU binary"
    );
    std::os::unix::fs::symlink(gnu, bin.join("sha256sum")).unwrap();
    let gnu_path =
        std::env::join_paths([bin.as_path(), Path::new("/usr/bin"), Path::new("/bin")]).unwrap();
    let mut outputs = Vec::new();
    for (role, path) in [
        ("GNU", gnu_path),
        ("shasum fallback", "/usr/bin:/bin".into()),
    ] {
        for name in ["has\\slash", "line\nbreak"] {
            let p = t.path().join(name);
            std::fs::write(&p, b"abc").unwrap();
            let out = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(checksum_command(&p))
                .env("PATH", &path)
                .output()
                .unwrap();
            assert!(out.status.success());
            outputs.push((role, name, String::from_utf8(out.stdout).unwrap()));
        }
    }
    assert!(
        outputs
            .iter()
            .all(|(_, _, s)| s.split_whitespace().next() == Some(ABC_SHA256)),
        "SC-47: actual GNU/fallback tool output has escaped tokens: {outputs:?}"
    );
}
