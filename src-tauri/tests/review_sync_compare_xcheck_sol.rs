//! R2 independent cross-checks. Only TempDir files; never OS trash or live SSH.
#[path = "support/undo_fixture.rs"]
mod undo_fixture;

use async_trait::async_trait;
use duet_lib::core::compare::{compare_dirs, compare_dirs_progress, CompareRules, CompareStatus};
use duet_lib::core::copy_progress::parse_rsync_itemize_created_file;
use duet_lib::core::ops::{
    apply_compare, merge_bidir, sync_execute, sync_plan, verify_compare, ApplyDecision,
    ApplyDirection, OpCtx,
};
use duet_lib::core::three_way::{compare_three_way, ThreeWayStatus};
use duet_lib::core::undo::{execute_undo, UndoKind};
use duet_lib::fs::{FileSystem, LocalFs};
use duet_lib::services::connection_pool::ConnectionPool;
use duet_lib::services::journal::{Journal, OpKind, UndoAction};
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{
    ConnectionId, DuetError, Entry, EntryMeta, Location, SourceId, TrashLocation,
};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};
use tempfile::{tempdir, TempDir};
use tokio_util::sync::CancellationToken;

fn loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.into(),
    }
}
fn trees() -> (TempDir, PathBuf, PathBuf) {
    let t = tempdir().unwrap();
    let l = t.path().join("L");
    let r = t.path().join("R");
    std::fs::create_dir(&l).unwrap();
    std::fs::create_dir(&r).unwrap();
    (t, l, r)
}
async fn ctx(p: &Path) -> OpCtx {
    OpCtx {
        journal: Journal::load_from(&p.join("j.jsonl")).await.unwrap(),
        settings: SettingsStore::load_from(&p.join("s.toml")).await.unwrap(),
        pool: None,
        app: None,
    }
}
fn write_at(p: &Path, data: &[u8], ms: u64) {
    std::fs::write(p, data).unwrap();
    std::fs::File::options()
        .write(true)
        .open(p)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_millis(ms)))
        .unwrap();
}

#[derive(Default)]
struct FixtureFs {
    fail_stat: Option<PathBuf>,
    fail_list: Option<PathBuf>,
    cancel_at_rename: Option<(PathBuf, CancellationToken)>,
    round_seconds: bool,
    record_only: bool,
    seen: Mutex<Vec<PathBuf>>,
}
#[async_trait]
impl FileSystem for FixtureFs {
    fn source_id(&self) -> SourceId {
        SourceId::Local
    }
    async fn list(&self, p: &Path) -> Result<Vec<Entry>, DuetError> {
        if self.fail_list.as_deref() == Some(p) {
            return Err(DuetError::ConnectionFailed(
                "fixture disconnected during list".into(),
            ));
        }
        let mut e = LocalFs.list(p).await?;
        e.sort_by(|a, b| a.name.cmp(&b.name));
        if self.round_seconds {
            for item in &mut e {
                item.modified_ms = item.modified_ms.map(|m| m / 1000 * 1000);
            }
        }
        Ok(e)
    }
    async fn metadata(&self, p: &Path) -> Result<EntryMeta, DuetError> {
        if self.record_only {
            self.seen.lock().unwrap().push(p.into());
            return Err(DuetError::NotFound("record-only fixture".into()));
        }
        if self.fail_stat.as_deref() == Some(p) {
            return Err(DuetError::PermissionDenied("fixture stat race".into()));
        }
        LocalFs.metadata(p).await
    }
    async fn rename(&self, f: &Path, t: &Path) -> Result<(), DuetError> {
        LocalFs.rename(f, t).await?;
        if let Some((target, token)) = &self.cancel_at_rename {
            if target == t {
                token.cancel();
            }
        }
        Ok(())
    }
    async fn mkdir(&self, p: &Path) -> Result<(), DuetError> {
        LocalFs.mkdir(p).await
    }
    async fn trash(&self, _: &Path, _: &str) -> Result<TrashLocation, DuetError> {
        panic!("OS trash forbidden")
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
#[ignore = "sync-compare repro: SC-01 independently confirmed in sol-2"]
async fn sc01_stat_failure_after_backup_keeps_original_in_place() {
    let (t, l, r) = trees();
    std::fs::write(l.join("b_한글"), b"new larger source").unwrap();
    std::fs::write(r.join("b_한글"), b"old").unwrap();
    let fs = FixtureFs {
        fail_stat: Some(l.join("b_한글")),
        ..Default::default()
    };
    let c = ctx(t.path()).await;
    let p = sync_plan(&fs, &fs, loc(&l), loc(&r)).await.unwrap();
    let out = sync_execute(&fs, &fs, p, &c, CancellationToken::new(), None).await;
    assert!(out.is_err());
    assert_eq!(
        std::fs::read(r.join("b_한글")).ok().as_deref(),
        Some(&b"old"[..]),
        "SC-01: failed source stat must not displace original destination"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: SC-01 independently confirmed in sol-2"]
async fn sc01_cancel_after_first_completed_file_keeps_journal() {
    let (t, l, r) = trees();
    std::fs::write(l.join("a"), b"first").unwrap();
    std::fs::write(l.join("b"), b"second").unwrap();
    let cancel = CancellationToken::new();
    let fs = FixtureFs {
        cancel_at_rename: Some((r.join("a"), cancel.clone())),
        ..Default::default()
    };
    let c = ctx(t.path()).await;
    let p = sync_plan(&fs, &fs, loc(&l), loc(&r)).await.unwrap();
    let out = sync_execute(&fs, &fs, p, &c, cancel, None).await;
    assert!(matches!(out, Err(DuetError::Cancelled)));
    assert!(r.join("a").exists());
    assert!(!r.join("b").exists());
    assert!(
        !c.journal.history(10).await.is_empty(),
        "SC-01: completed first file needs an undo entry after cancellation"
    );
}

#[tokio::test]
async fn sc04_sync_undo_preserves_edits_saved_after_sync() {
    let (t, l, r) = trees();
    std::fs::write(l.join("a"), b"source").unwrap();
    let c = ctx(t.path()).await;
    let p = sync_plan(&LocalFs, &LocalFs, loc(&l), loc(&r))
        .await
        .unwrap();
    let e = sync_execute(&LocalFs, &LocalFs, p, &c, CancellationToken::new(), None)
        .await
        .unwrap();
    std::fs::write(r.join("a"), b"edited after sync").unwrap();
    let out = undo_fixture::undo_tmp(&e).await;
    assert!(
        !matches!(out.kind, UndoKind::Ok)
            || std::fs::read(r.join("a")).ok().as_deref() == Some(&b"edited after sync"[..]),
        "SC-04: sync undo reported success while removing later work"
    );
}

#[tokio::test]
async fn sc04_copy_undo_preserves_edits_saved_after_copy() {
    let (t, l, r) = trees();
    let src = l.join("a");
    let dst = r.join("a");
    std::fs::write(&src, b"copied").unwrap();
    duet_lib::fs::copy_relay(&LocalFs, &src, &LocalFs, &dst)
        .await
        .unwrap();
    let c = ctx(t.path()).await;
    let e = c
        .journal
        .push(
            OpKind::Copy {
                count: 1,
                src: loc(&l),
                dst: loc(&r),
            },
            UndoAction::UndoCopy {
                target_source: SourceId::Local,
                copied: vec![dst.clone()],
                backups_to_restore: vec![],
                src_source: Some(SourceId::Local),
                copied_from: vec![src],
                copied_stamps: vec![],
            },
        )
        .await
        .unwrap();
    std::fs::write(&dst, b"editor save").unwrap();
    let out = undo_fixture::undo_tmp(&e).await;
    assert!(
        !matches!(out.kind, UndoKind::Ok) || dst.exists(),
        "SC-04: copy undo deletes a later editor save without trash"
    );
}

#[tokio::test]
async fn sc04_new_empty_file_guard_skips_when_filled() {
    let t = tempdir().unwrap();
    let p = t.path().join("created");
    std::fs::write(&p, b"").unwrap();
    let c = ctx(t.path()).await;
    let e = c
        .journal
        .push(
            OpKind::NewFile {
                path: p.clone(),
                source: SourceId::Local,
            },
            UndoAction::UndoNewFile {
                path: p.clone(),
                source: SourceId::Local,
            },
        )
        .await
        .unwrap();
    std::fs::write(&p, b"later saved text").unwrap();
    let out = execute_undo(&e, &ConnectionPool::new()).await;
    assert!(matches!(out.kind, UndoKind::Stale));
    assert_eq!(std::fs::read(p).unwrap(), b"later saved text");
}

async fn disconnected_three_way(changed: bool) -> duet_lib::core::three_way::ThreeWayPlan {
    let (t, l, r) = trees();
    let b = t.path().join("base");
    std::fs::create_dir(&b).unwrap();
    for side in [&b, &l, &r] {
        std::fs::create_dir(side.join("sub")).unwrap();
        write_at(&side.join("sub/a"), b"base", 1_700_000_000_000);
    }
    if changed {
        write_at(&l.join("sub/a"), b"changed on left", 1_700_000_020_000);
    }
    let failed = FixtureFs {
        fail_list: Some(r.join("sub")),
        ..Default::default()
    };
    compare_three_way(&LocalFs, loc(&b), &LocalFs, loc(&l), &failed, loc(&r))
        .await
        .unwrap()
}
#[tokio::test]
#[ignore = "sync-compare repro: SC-05 independently confirmed in sol-2"]
async fn sc05_connection_failure_is_not_automatic_deletion() {
    let p = disconnected_three_way(false).await;
    assert!(
        !p.entries
            .iter()
            .any(|e| e.status == ThreeWayStatus::RightDeleted),
        "SC-05: connection failure became automatic deletion"
    );
}
#[tokio::test]
async fn sc05_changed_survivor_becomes_conflict_instead_of_deletion() {
    let p = disconnected_three_way(true).await;
    assert_eq!(p.entries[0].status, ThreeWayStatus::DeleteConflict);
    assert_eq!(p.auto, 0);
    assert_eq!(p.conflicts, 1);
}

#[tokio::test]
#[ignore = "sync-compare repro: SC-07 independently confirmed in sol-2"]
async fn sc07_nested_log_ignore_survives_merge() {
    let (t, l, r) = trees();
    for side in [&l, &r] {
        std::fs::create_dir(side.join("logs")).unwrap();
    }
    std::fs::write(l.join("logs/한글.log"), b"excluded").unwrap();
    std::fs::write(l.join("visible"), b"keep").unwrap();
    let shown = compare_dirs_progress(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        &CompareRules {
            ignore_globs: vec!["*.log".into()],
            ..Default::default()
        },
        &CancellationToken::new(),
        &|_| {},
    )
    .await
    .unwrap();
    assert_eq!(shown.entries.len(), 1);
    merge_bidir(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        false,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert!(
        !r.join("logs/한글.log").exists(),
        "SC-07: ignored nested basename copied by fresh rule-free comparison"
    );
}

#[tokio::test]
#[ignore = "sync-compare repro: SC-08 independently confirmed in sol-2"]
async fn sc08_missing_reverse_nested_source_keeps_destination() {
    let (t, l, r) = trees();
    std::fs::create_dir(l.join("Case")).unwrap();
    std::fs::create_dir(r.join("Case")).unwrap();
    std::fs::write(l.join("Case/파일.txt"), b"left original").unwrap();
    let c = ctx(t.path()).await;
    let out = apply_compare(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        vec![ApplyDecision {
            rel: "Case/파일.txt".into(),
            direction: ApplyDirection::ToLeft,
        }],
        &c,
        CancellationToken::new(),
        None,
    )
    .await;
    assert!(out.is_err());
    assert!(c.journal.peek_undoable().await.unwrap().is_some());
    assert_eq!(
        std::fs::read(l.join("Case/파일.txt")).ok().as_deref(),
        Some(&b"left original"[..]),
        "SC-08: reverse nested destination displaced before missing source check"
    );
}

#[tokio::test]
async fn sc09_merge_undo_with_unreachable_left_changes_nothing() {
    let (t, l, r) = trees();
    std::fs::write(l.join("left"), b"L").unwrap();
    std::fs::write(r.join("right"), b"R").unwrap();
    let mut e = merge_bidir(
        &LocalFs,
        loc(&l),
        &LocalFs,
        loc(&r),
        false,
        &ctx(t.path()).await,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    if let UndoAction::UndoBidirMerge { left_source, .. } = &mut e.undo {
        *left_source = SourceId::Ssh {
            connection_id: ConnectionId("missing-left".into()),
            host_ip: "127.0.0.1".parse().unwrap(),
            user: "test".into(),
        };
    } else {
        panic!("expected merge");
    }
    let out = undo_fixture::undo_tmp(&e).await;
    // 한쪽에 닿지 못하면 어느 쪽도 건드리지 않고 Error — 재시도로 양쪽을 함께 되돌린다
    // (한쪽만 되돌린 채 확정하지 않음).
    assert!(l.join("right").exists());
    assert!(
        r.join("left").exists(),
        "nothing is undone while one side is unreachable"
    );
    assert!(
        matches!(out.kind, UndoKind::Error),
        "SC-09: undo with an unreachable side must stay retryable, got {:?}",
        out.kind
    );
}

#[test]
#[ignore = "sync-compare repro: SC-10 independently confirmed in sol-2"]
fn sc10_rsync3_octally_escaped_korean_round_trips() {
    let output = r">f+++++++++ \#355\#225\#234\#352\#270\#200.txt";
    assert_eq!(
        parse_rsync_itemize_created_file(output),
        Some("한글.txt".into()),
        "SC-10: GNU 11-column itemize must decode UTF-8 octets under C locale"
    );
}

#[cfg(unix)]
#[test]
#[ignore = "sync-compare repro: SC-10 independently confirmed in sol-2"]
fn sc10_local_system_rsync_supports_progress2() {
    let (_t, l, r) = trees();
    std::fs::write(l.join("safe"), b"x").unwrap();
    let out = std::process::Command::new("/usr/bin/rsync")
        .env("LC_ALL", "C")
        .args(["-a", "--info=progress2", "--"])
        .arg(l.join(""))
        .arg(&r)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "SC-10: rsync is present but progress2 rejected; exit={:?} stderr={}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn sc11_subsecond_local_metadata_and_seconds_view_classify_predictably() {
    let t = tempdir().unwrap();
    for i in 0..40 {
        std::fs::write(t.path().join(format!("f{i}")), b"same").unwrap();
    }
    let fractional = LocalFs
        .list(t.path())
        .await
        .unwrap()
        .iter()
        .filter(|e| e.modified_ms.unwrap() % 1000 != 0)
        .count();
    let seconds = FixtureFs {
        round_seconds: true,
        ..Default::default()
    };
    let p = compare_dirs(&LocalFs, loc(t.path()), &seconds, loc(t.path()))
        .await
        .unwrap();
    assert_eq!(p.differ as usize, fractional);
    assert_eq!(p.same as usize, 40 - fractional);
    assert!(p
        .entries
        .iter()
        .filter(|e| e.status != CompareStatus::Same)
        .all(|e| e.status == CompareStatus::NewerLeft));
}

#[tokio::test]
async fn sc51_verify_records_windows_path_strings_without_touching_them() {
    for (base, want) in [
        (r"C:\a", r"C:\a/sub/x"),
        (r"\\?\C:\a", r"\\?\C:\a/sub/x"),
        (r"C:\", r"C:\/sub/x"),
    ] {
        let fs = FixtureFs {
            record_only: true,
            ..Default::default()
        };
        let location = loc(Path::new(base));
        let v = verify_compare(&fs, &location, &fs, &location, vec!["sub/x".into()], None)
            .await
            .unwrap();
        assert_eq!(v[0].equal, None);
        let seen = fs.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0].to_string_lossy(), want);
    }
}
