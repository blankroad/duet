//! UX smoke (2026-11-10, fileops): user workflows that reach `core::ops` with
//! real `LocalFs` + `Journal` in temp dirs. No OS trash, no user files, no servers.
//!
//! Scenarios a user hits without doing anything unusual:
//! - F5 / F6 when both panes show the same folder, or Ctrl+C → Ctrl+V in the same
//!   folder (the FE only blocks the cut→paste same-folder case).
//! - Rename onto an existing name, batch rename that maps two items to one name,
//!   new folder with an existing name.
//!
//! Tests marked `#[ignore = "ux-fileops-NN repro"]` reproduce a defect: they fail
//! today and become regression tests once the mark is removed.
//!
//! Run: `cargo test --test ux_smoke_fileops_opus` (add `-- --ignored` for repros).

use std::path::Path;

use duet_lib::core::ops::{
    batch_rename_execute, copy_execute, copy_plan, mkdir, move_execute, move_plan, rename,
    ConflictPolicy, OpCtx, RenameRule,
};
use duet_lib::fs::LocalFs;
use duet_lib::services::journal::Journal;
use duet_lib::services::settings::SettingsStore;
use duet_lib::types::{ConnectionId, DuetError, EntryRef, Location, SourceId};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;

struct Env {
    work: TempDir,
    _cfg: TempDir,
    ctx: OpCtx,
}

async fn setup() -> Env {
    let work = TempDir::new().unwrap();
    let cfg = TempDir::new().unwrap();
    let ctx = OpCtx {
        settings: SettingsStore::load_from(&cfg.path().join("s.toml"))
            .await
            .unwrap(),
        journal: Journal::load_from(&cfg.path().join("j.jsonl"))
            .await
            .unwrap(),
        pool: None,
        app: None,
    };
    Env {
        work,
        _cfg: cfg,
        ctx,
    }
}

fn loc(p: &Path) -> Location {
    Location {
        source: SourceId::Local,
        path: p.to_path_buf(),
    }
}

fn target(p: &Path, name: &str) -> EntryRef {
    EntryRef {
        location: loc(p),
        name: name.into(),
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

async fn copy_same_folder(env: &Env, name: &str, policy: ConflictPolicy) -> Result<(), DuetError> {
    let fs = LocalFs::new();
    let dir = env.work.path();
    let plan = copy_plan(&fs, &fs, vec![target(dir, name)], loc(dir)).await?;
    copy_execute(
        &fs,
        &fs,
        plan,
        policy,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .map(|_| ())
}

async fn move_same_folder(env: &Env, name: &str, policy: ConflictPolicy) -> Result<(), DuetError> {
    let fs = LocalFs::new();
    let dir = env.work.path();
    let plan = move_plan(&fs, &fs, vec![target(dir, name)], loc(dir)).await?;
    move_execute(
        &fs,
        &fs,
        plan,
        policy,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .map(|_| ())
}

// ── Same-folder copy (F5 with both panes on one folder / Ctrl+C → Ctrl+V) ──

/// The plan reports every item as conflicting with itself, so the confirm dialog
/// offers "Replace a.txt with a.txt".
#[tokio::test]
async fn same_folder_copy_plan_lists_item_as_conflict_with_itself() {
    let env = setup().await;
    let fs = LocalFs::new();
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
    let plan = copy_plan(&fs, &fs, vec![target(dir, "a.txt")], loc(dir))
        .await
        .unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(plan.conflicts[0].dst_path, dir.join("a.txt"));
}

/// KeepBoth = Explorer-style duplicate: original untouched, numbered copy added.
#[tokio::test]
async fn same_folder_copy_keep_both_makes_numbered_duplicate() {
    let env = setup().await;
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
    copy_same_folder(&env, "a.txt", ConflictPolicy::KeepBoth)
        .await
        .unwrap();
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"ORIGINAL");
    let all = names(dir);
    assert_eq!(all.len(), 2, "{all:?}");
    let dup = all.iter().find(|n| *n != "a.txt").unwrap();
    assert_eq!(std::fs::read(dir.join(dup)).unwrap(), b"ORIGINAL");
}

/// Skip leaves the folder as it was.
#[tokio::test]
async fn same_folder_copy_skip_changes_nothing() {
    let env = setup().await;
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
    copy_same_folder(&env, "a.txt", ConflictPolicy::Skip)
        .await
        .unwrap();
    assert_eq!(names(dir), vec!["a.txt"]);
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"ORIGINAL");
}

/// Data-safety baseline: Replace on itself must never lose the file, whatever it reports.
#[tokio::test]
async fn same_folder_copy_replace_file_keeps_original() {
    let env = setup().await;
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
    let r = copy_same_folder(&env, "a.txt", ConflictPolicy::Replace).await;
    assert_eq!(
        std::fs::read(dir.join("a.txt")).ok().as_deref(),
        Some(&b"ORIGINAL"[..]),
        "result {r:?}, folder now {:?}",
        names(dir)
    );
    assert_eq!(names(dir), vec!["a.txt"], "no backup residue; result {r:?}");
}

/// Data-safety baseline for a folder replaced by itself.
#[tokio::test]
async fn same_folder_copy_replace_dir_keeps_contents() {
    let env = setup().await;
    let dir = env.work.path();
    std::fs::create_dir(dir.join("d")).unwrap();
    std::fs::write(dir.join("d/inner.txt"), b"INNER").unwrap();
    let r = copy_same_folder(&env, "d", ConflictPolicy::Replace).await;
    assert_eq!(
        std::fs::read(dir.join("d/inner.txt")).ok().as_deref(),
        Some(&b"INNER"[..]),
        "result {r:?}, folder now {:?}",
        names(dir)
    );
}

/// UX: Replace-onto-itself is a no-op request. It should succeed quietly (or be refused
/// at plan time with a clear reason) — not fail with a generic I/O error after the user
/// confirmed. Records what the user sees today.
#[tokio::test]
#[ignore = "ux-fileops-01 repro"]
async fn same_folder_copy_replace_is_not_reported_as_failure() {
    let env = setup().await;
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
    let r = copy_same_folder(&env, "a.txt", ConflictPolicy::Replace).await;
    assert!(
        r.is_ok() || matches!(r, Err(DuetError::IntoItself(_))),
        "Replace onto itself reported {r:?}"
    );
}

// ── Same-folder move (F6 with both panes on one folder) ──

/// Data-safety baseline: moving onto itself with any policy keeps the file.
#[tokio::test]
async fn same_folder_move_any_policy_keeps_original() {
    for policy in [
        ConflictPolicy::Replace,
        ConflictPolicy::KeepBoth,
        ConflictPolicy::Skip,
    ] {
        let env = setup().await;
        let dir = env.work.path();
        std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
        let r = move_same_folder(&env, "a.txt", policy).await;
        let all = names(dir);
        let kept: Vec<_> = all
            .iter()
            .filter(|n| std::fs::read(dir.join(n)).ok().as_deref() == Some(&b"ORIGINAL"[..]))
            .collect();
        assert_eq!(kept.len(), 1, "{policy:?}: result {r:?}, folder {all:?}");
    }
}

/// UX: F6 into the same folder should be a no-op (or refused with a reason) — KeepBoth
/// must not silently rename the user's file to `a (1).txt`.
#[tokio::test]
#[ignore = "ux-fileops-01 repro"]
async fn same_folder_move_keep_both_does_not_rename_original() {
    let env = setup().await;
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"ORIGINAL").unwrap();
    let r = move_same_folder(&env, "a.txt", ConflictPolicy::KeepBoth).await;
    assert_eq!(names(dir), vec!["a.txt"], "result {r:?}");
}

// ── Rename / batch rename / new folder onto existing names ──

#[tokio::test]
async fn rename_onto_existing_name_is_refused_and_keeps_both() {
    let env = setup().await;
    let fs = LocalFs::new();
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"A").unwrap();
    std::fs::write(dir.join("b.txt"), b"B").unwrap();
    let r = rename(&fs, target(dir, "a.txt"), "b.txt".into(), &env.ctx).await;
    assert!(r.is_err());
    assert_eq!(std::fs::read(dir.join("a.txt")).unwrap(), b"A");
    assert_eq!(std::fs::read(dir.join("b.txt")).unwrap(), b"B");
}

/// UX: the refusal is an "already exists" error so the toast can say so in the user's
/// language (it used to be `Io("target exists: <path>")`).
#[tokio::test]
async fn rename_onto_existing_name_reports_already_exists_kind() {
    let env = setup().await;
    let fs = LocalFs::new();
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"A").unwrap();
    std::fs::write(dir.join("b.txt"), b"B").unwrap();
    let r = rename(&fs, target(dir, "a.txt"), "b.txt".into(), &env.ctx).await;
    let e = r.unwrap_err();
    let msg = format!("{e:?}");
    assert!(
        !matches!(e, DuetError::Io(_)) || msg.contains("already exists"),
        "rename collision surfaced as {msg}"
    );
}

fn base_rule(base: &str) -> RenameRule {
    RenameRule {
        base: Some(base.into()),
        find: String::new(),
        replace: String::new(),
        replace_all: false,
        prefix: String::new(),
        suffix: String::new(),
        seq: None,
        case: None,
        target_ext: false,
    }
}

/// Batch rename that maps two items to the same name: nothing changes.
#[tokio::test]
async fn batch_rename_internal_collision_changes_nothing() {
    let env = setup().await;
    let fs = LocalFs::new();
    let dir = env.work.path();
    std::fs::write(dir.join("x.txt"), b"X").unwrap();
    std::fs::write(dir.join("y.txt"), b"Y").unwrap();
    let r = batch_rename_execute(
        &fs,
        vec![target(dir, "x.txt"), target(dir, "y.txt")],
        base_rule("same"),
        &env.ctx,
    )
    .await;
    assert!(r.is_err(), "{r:?}");
    assert_eq!(names(dir), vec!["x.txt", "y.txt"]);
}

/// New folder with a name that already exists: refused, existing folder untouched.
#[tokio::test]
async fn mkdir_existing_name_is_refused() {
    let env = setup().await;
    let fs = LocalFs::new();
    let dir = env.work.path();
    std::fs::create_dir(dir.join("d")).unwrap();
    std::fs::write(dir.join("d/keep.txt"), b"K").unwrap();
    let r = mkdir(&fs, loc(dir), "d".into(), &env.ctx).await;
    assert!(r.is_err(), "{r:?}");
    assert_eq!(std::fs::read(dir.join("d/keep.txt")).unwrap(), b"K");
}

// ── Multi-selection transfer with mixed conflicts ──

/// Multi-select copy where only some items conflict, KeepBoth: every item lands,
/// the existing one is untouched.
#[tokio::test]
async fn multi_copy_mixed_conflicts_keep_both() {
    let env = setup().await;
    let fs = LocalFs::new();
    let src = env.work.path().join("src");
    let dst = env.work.path().join("dst");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::create_dir(&dst).unwrap();
    std::fs::write(src.join("a.txt"), b"NEW-A").unwrap();
    std::fs::write(src.join("b.txt"), b"NEW-B").unwrap();
    std::fs::write(src.join("sub/s.txt"), b"S").unwrap();
    std::fs::write(dst.join("a.txt"), b"OLD-A").unwrap();
    let items = vec![
        target(&src, "a.txt"),
        target(&src, "b.txt"),
        target(&src, "sub"),
    ];
    let plan = copy_plan(&fs, &fs, items, loc(&dst)).await.unwrap();
    assert_eq!(plan.conflicts.len(), 1);
    copy_execute(
        &fs,
        &fs,
        plan,
        ConflictPolicy::KeepBoth,
        &env.ctx,
        CancellationToken::new(),
        None,
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"OLD-A");
    assert_eq!(std::fs::read(dst.join("b.txt")).unwrap(), b"NEW-B");
    assert_eq!(std::fs::read(dst.join("sub/s.txt")).unwrap(), b"S");
    assert_eq!(names(&dst).len(), 4, "{:?}", names(&dst));
}

/// Mixed selection from two folders is refused at plan time (the FE never builds one
/// from a single pane, but the shelf/clipboard could carry one).
#[tokio::test]
async fn plan_refuses_items_from_different_sources() {
    let env = setup().await;
    let fs = LocalFs::new();
    let dir = env.work.path();
    std::fs::write(dir.join("a.txt"), b"A").unwrap();
    let remote = EntryRef {
        location: Location {
            source: SourceId::Ssh {
                connection_id: ConnectionId("c1".into()),
                host_ip: "127.0.0.1".parse().unwrap(),
                user: "u".into(),
            },
            path: "/tmp".into(),
        },
        name: "r.txt".into(),
    };
    let r = copy_plan(&fs, &fs, vec![target(dir, "a.txt"), remote], loc(dir)).await;
    assert!(r.is_err());
}
